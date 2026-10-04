import {
  readSegmentConditionRows,
  type Scope,
  type SegmentConditionRow,
} from "@openconditions/core";
import {
  type Catalog,
  type EffectiveRights,
  isPublicLicense,
  missingCredentials,
} from "@openconditions/ingest-framework";
import type { RoutingRights } from "@openconditions/model";
import {
  flowToSegmentSpeedCsv,
  type SegmentSpeedCsvRow,
  type SegmentSpeedRow,
  segmentConditionsToExclusions,
  segmentConditionsToJson,
  segmentsToGeoJSON,
} from "@openconditions/publishers";
import { RESOLVER_VERSION } from "@openconditions/roads";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { parseBbox } from "./api/query.js";
import { scopeOf } from "./api/scope.js";
import type { FeedRunStatus, FeedStatusStore } from "./feed-status.js";
import {
  type BindingMetrics,
  type BindingMetricsReader,
  createBindingMetricsReader,
} from "./pipeline/binding-metrics.js";
import { routingRightsOf } from "./pipeline/publish.js";
import {
  readSourceOperationalStatus,
  type SourceOperationalStatus,
  type SourceStatusReader,
} from "./pipeline/source-status.js";

type Sql = postgres.Sql;
type BBox = [number, number, number, number];

export interface FeedGraphStatus {
  generation: string | null;
  status: "ready" | "partial" | "missing" | "unknown";
  regions: string[];
}
export type FeedGraphStatusReader = () => Promise<FeedGraphStatus>;

export async function readFeedGraphStatus(sql: Sql): Promise<FeedGraphStatus> {
  const rows = await sql<{ generation: string; status: string; regions: unknown }[]>`
    SELECT generation, status, regions FROM conditions.road_graph_state WHERE singleton`;
  const row = rows[0];
  if (!row) return { generation: null, status: "missing", regions: [] };
  const raw = Array.isArray(row.regions) ? row.regions : [];
  const regions = raw
    .map((region) =>
      typeof region === "string"
        ? region
        : region &&
            typeof region === "object" &&
            typeof (region as { id?: unknown }).id === "string"
          ? (region as { id: string }).id
          : null,
    )
    .filter((region): region is string => region != null);
  return {
    generation: row.generation,
    status: row.status === "ready" && regions.length > 0 ? "ready" : "partial",
    regions,
  };
}

function fullIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Routing rights with the review instant as a full ISO timestamp. */
function routingRights(rights: RoutingRights | null | undefined): RoutingRights | null {
  if (!rights) return null;
  return { ...rights, reviewed_at: fullIso(rights.reviewed_at) };
}

/**
 * Segment condition rows as `scope` may route on them, with their catalogue
 * routing source, licence link, attribution and rights. The public scope
 * drops a restricted source's rows (restricted in `storedRestricted`, read
 * from `conditions.source`, or a feed the catalogue schedules, keeps
 * disabled or only discovered), an unscheduled catalogue child's, and rows
 * whose licence is not public; the operator scope keeps every row.
 */
export function hydrateSegmentRows(
  rows: SegmentConditionRow[],
  catalog: Catalog,
  scope: Scope,
  storedRestricted: ReadonlySet<string>,
): SegmentConditionRow[] {
  const feedById = new Map(catalog.feeds.map((feed) => [feed.id, feed] as const));
  // A discovered catalogue child is explicitly outside the scheduled selection.
  // Its retained observations must not regain an old grant through the fallback
  // for remote sources, which legitimately have no local feed descriptor.
  const unscheduledSourceIds = new Set(
    catalog.discovered.filter((feed) => !feedById.has(feed.id)).map((feed) => feed.id),
  );
  const restrictedSourceIds = new Set([
    ...storedRestricted,
    ...[...catalog.feeds, ...catalog.discovered, ...catalog.disabled]
      .filter((feed) => feed.restricted)
      .map((feed) => feed.id),
  ]);
  return rows
    .filter((row) => {
      if (scope === "operator") return true;
      const license = row.provenance_attribution?.license;
      return (
        !unscheduledSourceIds.has(row.source_id) &&
        !restrictedSourceIds.has(row.source_id) &&
        isPublicLicense(license) &&
        isPublicLicense(feedById.get(row.source_id)?.license ?? license)
      );
    })
    .map((row) => {
      const feed = feedById.get(row.source_id);
      const attribution = row.provenance_attribution;
      const parentSourceId = feed?.parentSourceId ?? attribution?.parentSourceId;
      return {
        ...row,
        routing_source_id: parentSourceId ?? row.source_id,
        child_source_id: parentSourceId ? row.source_id : null,
        license_url: feed?.licenseUrl ?? attribution?.licenseUrl ?? attribution?.url ?? null,
        attribution: attribution?.provider ?? feed?.attribution ?? null,
        rights: routingRights(feed ? routingRightsOf(feed) : attribution?.rights),
      };
    });
}

/**
 * The source ids of `rows` that `conditions.source` marks restricted, in one
 * query; none for the operator, who routes on every row.
 */
async function storedRestrictedOf(
  sql: Sql,
  rows: readonly SegmentConditionRow[],
  scope: Scope,
): Promise<Set<string>> {
  const ids = [...new Set(rows.map((r) => r.source_id))];
  if (scope === "operator" || ids.length === 0) return new Set();
  const found = await sql<{ id: string }[]>`
    SELECT id FROM conditions.source WHERE id = ANY(${ids}::text[]) AND restricted`;
  return new Set(found.map((r) => r.id));
}

/**
 * The SQL condition, over a table with a `contributing` source-id array
 * (`segment_speed` aliased `sp`, or whichever `alias` names), under which
 * `scope` may read a derived value: the operator any, the public none a
 * restricted source contributed to.
 */
function speedScopeClause(scope: Scope, alias = "sp"): string {
  return scope === "operator"
    ? "true"
    : `NOT EXISTS (SELECT 1 FROM conditions.source scope_source
                    WHERE scope_source.id = ANY(${alias}.contributing) AND scope_source.restricted)`;
}

/**
 * The SQL condition, over `segment_profile` aliased `sp`, under which `scope`
 * may read a segment's weekly profile: the operator any, the public none with
 * a bucket that names a restricted source or no source at all (provenance
 * unknown, so withheld). One pass over the buckets, not one per row.
 */
function profileScopeClause(scope: Scope): string {
  if (scope === "operator") return "true";
  return `sp.segment_id NOT IN (
    SELECT withheld.segment_id FROM conditions.segment_profile withheld
     WHERE cardinality(withheld.contributing) = 0
        OR NOT (${speedScopeClause(scope, "withheld")}))`;
}

/** One `road_segment JOIN segment_profile` row: a single weekly-profile bucket
 * for a directed segment, from the weekly-profile derive job. `wayId` is a
 * bigint column -- postgres-js returns it as a `string`, not a `number` (same
 * convention as `SegmentSpeedCsvRow.wayId`). */
type SegmentProfileBucketRow = {
  segmentId: string;
  wayId: string | number;
  dir: string;
  freeFlowKph: number | null;
  dow: number;
  todHour: number;
  speedKph: number;
};

/** First/last local hour (inclusive) of Valhalla's `constrained` window --
 * `constrained` applies strictly 07:00-19:00 local, `freeflow` at night. */
const DAYTIME_START_HOUR = 7;
const DAYTIME_END_HOUR = 19;

/** Median of a non-empty numeric array (average of the two middle values on
 * an even-length input). Caller guarantees non-empty. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Adapt postgres-js to the QueryRunner (`execute`) interface the readers expect. */
function runner(sql: Sql) {
  return {
    async execute<T = unknown>(q: string, p?: unknown[]): Promise<T> {
      const rows = p ? await sql.unsafe(q, p as never[]) : await sql.unsafe(q);
      return rows as T;
    },
  };
}

/** One row of the `GET /feeds/status` listing: feed metadata + its run status. */
export type FeedStatusRow = {
  id: string;
  name: string;
  domain: string;
  hasCredentials: boolean;
  missingEnv: string[];
  selectionState: "approved" | "discovered" | "configured";
  parentSourceId?: string;
  cadenceSec: number;
  freshnessWindowSec: number;
  rights: EffectiveRights;
  /** Set on a feed the catalogue keeps but never polls, with the catalogue's reason. */
  state?: "disabled";
  disabledReason?: string;
  /** Binding outcomes of this feed's events; absent while it has no bindings. */
  binding?: BindingMetrics;
} & FeedRunStatus;

function legacyStatus(status: SourceOperationalStatus): FeedRunStatus {
  return {
    ...(status.lastAttemptAt ? { lastRunAt: status.lastAttemptAt } : {}),
    ...(status.lastNetworkSuccessAt ? { lastSuccessAt: status.lastNetworkSuccessAt } : {}),
    ...(status.lastError ? { lastError: status.lastError } : {}),
    ...(status.lastErrorAt ? { lastErrorAt: status.lastErrorAt } : {}),
    ...(status.activeEvents != null ? { lastRowCount: status.activeEvents } : {}),
    ...(status.lastDurationMs != null ? { lastDurationMs: status.lastDurationMs } : {}),
  };
}

/**
 * Registers `GET /feeds/status`: every scheduled feed of the catalogue,
 * joined with its runtime status (last run/success/error, row count) and with
 * how well its events bind to the segment spine, then the discovered catalogue
 * children and the disabled feeds with their reason. Mirrors the scheduler's
 * own credential check (a feed runs iff no credential it needs is missing) so
 * the two never disagree.
 *
 * The binding metrics are a read-only extra, so a failing metrics query is
 * logged and the listing is still served — just without `binding` keys.
 */
export function registerFeedStatusRoute(
  app: FastifyInstance,
  statusStore: FeedStatusStore,
  catalog: Catalog,
  bindingMetrics: BindingMetricsReader,
  sourceStatus?: SourceStatusReader,
  graphStatus?: FeedGraphStatusReader,
): void {
  app.get("/feeds/status", async () => {
    const collectedAt = new Date().toISOString();
    let durable = new Map<string, SourceOperationalStatus>();
    let graph: FeedGraphStatus = { generation: null, status: "unknown", regions: [] };
    if (sourceStatus) {
      try {
        durable = await sourceStatus();
      } catch (err) {
        app.log.error({ err }, "source status unavailable for /feeds/status");
      }
    }
    if (graphStatus) {
      try {
        graph = await graphStatus();
      } catch (err) {
        app.log.error({ err }, "graph status unavailable for /feeds/status");
      }
    }
    let metrics: Map<string, BindingMetrics> = new Map();
    try {
      metrics = await bindingMetrics();
    } catch (err) {
      app.log.error({ err }, "binding metrics unavailable for /feeds/status");
    }
    const feeds: FeedStatusRow[] = [];
    for (const feed of catalog.feeds) {
      const missingEnv = missingCredentials(feed);
      const binding = metrics.get(feed.id);
      const persisted = durable.get(feed.id);
      feeds.push({
        id: feed.id,
        name: feed.name,
        domain: feed.domain,
        hasCredentials: missingEnv.length === 0,
        missingEnv,
        selectionState: feed.selectionState ?? "configured",
        parentSourceId: feed.parentSourceId,
        cadenceSec: feed.cadenceSec,
        freshnessWindowSec: feed.freshnessWindowSec,
        rights: feed.rights,
        ...(persisted
          ? { ...legacyStatus(persisted), ...persisted }
          : (statusStore.get(feed.id) ?? {})),
        ...(binding ? { binding } : {}),
      });
    }
    for (const feed of catalog.discovered) {
      feeds.push({
        id: feed.id,
        name: feed.name,
        domain: feed.domain,
        hasCredentials: false,
        missingEnv: [],
        selectionState: "discovered",
        parentSourceId: feed.parentSourceId,
        cadenceSec: feed.cadenceSec,
        freshnessWindowSec: feed.freshnessWindowSec,
        rights: feed.rights,
      });
    }
    for (const feed of catalog.disabled) {
      const missingEnv = missingCredentials(feed);
      feeds.push({
        id: feed.id,
        name: feed.name,
        domain: feed.domain,
        hasCredentials: missingEnv.length === 0,
        missingEnv,
        selectionState: feed.selectionState ?? "configured",
        cadenceSec: feed.cadenceSec,
        freshnessWindowSec: feed.freshnessWindowSec,
        rights: feed.rights,
        state: "disabled",
        disabledReason: feed.disabled!.reason,
      });
    }
    return { schemaVersion: "2.0", instanceId: "openconditions", collectedAt, graph, feeds };
  });
}

/**
 * The segment-spine endpoints: routing outputs over bound situation effects
 *   GET /valhalla/exclusions.json · /segments/conditions.json
 * and the speed surface and operator status
 *   GET /segments.geojson · /segments/speed.csv · /segments/profiles.json ·
 *       /feeds/status
 * Records themselves leave through the record API (`api/routes.ts`). Every
 * route here reads in the request's scope.
 *
 * The routing outputs drop, in the public scope, a restricted source's rows
 * and rows whose licence is not public (`hydrateSegmentRows`).
 *
 * The speed surface (`/segments.geojson`, `/segments/speed.csv`) serves
 * `segment_speed`, a fused product: for a segment with a single contributing
 * source it is effectively that source's own reading. In the public scope a
 * speed any restricted source contributed to (`segment_speed.contributing`,
 * which a propagated estimate inherits from its measurement) is withheld:
 * `/segments.geojson` keeps the segment's geometry without speed properties,
 * `/segments/speed.csv` omits the row. A share-alike source is restricted, so
 * this is the licence filter too. The operator scope serves every speed.
 *
 * `/segments/profiles.json` serves the weekly profiles, each bucket recording
 * the sources it was built from (`segment_profile.contributing`). The public
 * scope omits a segment whose profile any restricted source contributed to, or
 * whose provenance is unrecorded;
 * the operator scope serves every profile.
 */
export function registerPublishRoutes(
  app: FastifyInstance,
  sql: Sql,
  statusStore: FeedStatusStore,
  catalog: Catalog,
): void {
  const db = runner(sql);

  app.get("/valhalla/exclusions.json", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const bbox = parseBbox(q.bbox);
    if (!bbox) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const at = q.at ? new Date(q.at) : new Date();
    if (Number.isNaN(at.getTime())) {
      return reply.status(400).send({ error: "at must be an ISO 8601 timestamp" });
    }
    const raw = await readSegmentConditionRows(db, {
      at,
      bbox,
      resolverVersion: RESOLVER_VERSION,
    });
    const evaluatedAt = new Date();
    const scope = scopeOf(req);
    const rows = hydrateSegmentRows(raw, catalog, scope, await storedRestrictedOf(sql, raw, scope));
    const projected = segmentConditionsToJson(rows, at, {
      resolverVersion: RESOLVER_VERSION,
      evaluatedAt,
    });
    const exclusions = segmentConditionsToExclusions(projected.conditions, {
      activeAt: at,
      evaluatedAt,
    });
    reply.header("Content-Type", "application/json");
    const deadlines = projected.conditions.flatMap((condition) =>
      [
        condition.routing_evidence.fresh_until,
        condition.routing_evidence.expires_at,
        condition.routing_evidence.valid_to,
        condition.routing_evidence.next_transition_at,
      ]
        .filter((value): value is string => value != null)
        .map((value) => Date.parse(value))
        .filter(Number.isFinite),
    );
    const maxAge =
      deadlines.length === 0
        ? 0
        : Math.max(
            0,
            Math.min(90, Math.floor((Math.min(...deadlines) - evaluatedAt.getTime()) / 1000)),
          );
    reply.header("Cache-Control", `public, max-age=${maxAge}`);
    const licenses = new Set(projected.conditions.map((c) => c.routing_evidence.source_license));
    reply.header("X-Data-License", licenses.size > 0 ? [...licenses].sort().join(", ") : "unknown");
    return reply.send({ ...exclusions, routing_evidence: projected });
  });

  app.get("/segments.geojson", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const bbox = parseBbox(q.bbox);
    if (!bbox) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const [west, south, east, north] = bbox;
    // postgres-js returns `timestamptz` as a JS `Date`, not a string (same as
    // the observations readers) -- coerce to ISO before handing rows to
    // segmentsToGeoJSON, which expects SegmentSpeedRow.observedAt as a string.
    const rawRows = await db.execute<
      Array<Omit<SegmentSpeedRow, "observedAt"> & { observedAt?: string | Date | null }>
    >(
      `SELECT s.segment_id AS "segmentId", s.dir, s.highway, s.ref,
              ST_AsGeoJSON(s.geom) AS geojson,
              sp.speed_ratio AS "speedRatio", sp.los, sp.confidence,
              sp.current_kph AS "currentKph", sp.free_flow_kph AS "freeFlowKph",
              sp.observed_at AS "observedAt"
       FROM conditions.road_segment s
       LEFT JOIN conditions.segment_speed sp
         ON sp.segment_id = s.segment_id AND ${speedScopeClause(scopeOf(req))}
       WHERE s.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
       LIMIT 20000`,
      [west, south, east, north],
    );
    const rows: SegmentSpeedRow[] = rawRows.map((row) => ({
      ...row,
      observedAt: row.observedAt instanceof Date ? row.observedAt.toISOString() : row.observedAt,
    }));
    reply.header("Content-Type", "application/geo+json");
    reply.header("Cache-Control", "public, max-age=60");
    return reply.send(segmentsToGeoJSON(rows));
  });

  // Routing feed for the OpenMapX `traffic.tar` writer: one row per directed
  // segment that HAS a measured/fused speed (unlike `/segments.geojson`,
  // segments with no `segment_speed` row are omitted rather than LEFT-JOINed
  // in as nulls — a routing consumer has no use for a speed-less row).
  app.get("/segments/speed.csv", async (req, reply) => {
    const rows = await db.execute<SegmentSpeedCsvRow[]>(
      `SELECT rs.way_id AS "wayId", rs.dir, sp.current_kph AS "currentKph",
              sp.free_flow_kph AS "freeFlowKph", sp.los
       FROM conditions.segment_speed sp
       JOIN conditions.road_segment rs USING (segment_id)
       WHERE sp.current_kph IS NOT NULL AND ${speedScopeClause(scopeOf(req))}`,
    );
    reply.header("Content-Type", "text/csv");
    reply.header("Cache-Control", "public, max-age=60");
    return reply.send(flowToSegmentSpeedCsv(rows));
  });

  // Weekly speed-profile export for the OpenMapX predicted-traffic baker,
  // which expands each segment into Valhalla's 2016 five-minute weekly buckets
  // and bakes them via `valhalla_add_predicted_traffic`. One entry per directed
  // segment that has at least one `segment_profile` bucket.
  //
  // `hourly[dow * 24 + tod_hour] = speed_kph` (null where no bucket exists)
  // is **Sunday-first (dow 0=Sun...6=Sat), in the segment's REGION-LOCAL
  // time** -- this is exactly Valhalla's own `DateTime::second_of_week`
  // bucket convention (source-verified), NOT UTC and NOT Monday-first. The baker indexes this array directly;
  // re-deriving a different week start on that side would silently shift
  // every region's rush hour.
  //
  // In the public scope a segment is omitted whole when any of its buckets was
  // built from a restricted source, or from no recorded source: `constrained_kph`
  // blends the daytime buckets, so a partial profile would still carry that
  // source's history.
  app.get("/segments/profiles.json", async (req, reply) => {
    const rows = await db.execute<SegmentProfileBucketRow[]>(
      `SELECT rs.segment_id AS "segmentId", rs.way_id AS "wayId", rs.dir,
              rs.free_flow_kph AS "freeFlowKph",
              sp.dow, sp.tod_hour AS "todHour", sp.speed_kph AS "speedKph"
       FROM conditions.segment_profile sp
       JOIN conditions.road_segment rs USING (segment_id)
       WHERE ${profileScopeClause(scopeOf(req))}
       ORDER BY rs.segment_id`,
    );

    const bySegment = new Map<
      string,
      {
        wayId: string | number;
        dir: string;
        freeFlowKph: number | null;
        hourly: (number | null)[];
      }
    >();
    for (const row of rows) {
      let entry = bySegment.get(row.segmentId);
      if (!entry) {
        entry = {
          wayId: row.wayId,
          dir: row.dir,
          freeFlowKph: row.freeFlowKph,
          hourly: new Array<number | null>(168).fill(null),
        };
        bySegment.set(row.segmentId, entry);
      }
      entry.hourly[row.dow * 24 + row.todHour] = row.speedKph;
    }

    const segments = [...bySegment.values()].map(({ wayId, dir, freeFlowKph, hourly }) => {
      // Median of the daytime (07:00-19:00 local, inclusive) buckets only;
      // Valhalla treats an absent/0 constrained speed as "don't set" and
      // warns on predicted-without-freeflow/constrained, so this always
      // falls back to free_flow_kph rather than omitting the field.
      const daytime = hourly.filter(
        (v, i): v is number =>
          v != null && i % 24 >= DAYTIME_START_HOUR && i % 24 <= DAYTIME_END_HOUR,
      );
      const constrainedKph = daytime.length > 0 ? median(daytime) : freeFlowKph;
      return {
        way_id: wayId,
        dir,
        free_flow_kph: freeFlowKph,
        constrained_kph: constrainedKph,
        hourly,
      };
    });

    reply.header("Content-Type", "application/json");
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send(segments);
  });

  // Routing feed of the BOUND effects in effect at `at` (default now), one row
  // per effect keyed by directed OSM way spans, for the OpenMapX live traffic
  // writer. In the public scope a restricted source's rows and rows whose
  // licence is not public are dropped; the operator scope routes on all. Only
  // `exact`/`likely` bindings are read; see `readSegmentConditionRows` for the
  // span geometry.
  app.get("/segments/conditions.json", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const bbox = q.bbox === undefined ? undefined : parseBbox(q.bbox);
    if (bbox === null)
      return reply.status(400).send({ error: "bbox must be west,south,east,north" });
    const at = q.at ? new Date(q.at) : new Date();
    if (Number.isNaN(at.getTime())) {
      return reply.status(400).send({ error: "at must be an ISO 8601 timestamp" });
    }
    const rows = await readSegmentConditionRows(db, {
      at,
      ...(bbox ? { bbox } : {}),
      resolverVersion: RESOLVER_VERSION,
    });
    const scope = scopeOf(req);
    const served = hydrateSegmentRows(
      rows,
      catalog,
      scope,
      await storedRestrictedOf(sql, rows, scope),
    );
    const projected = segmentConditionsToJson(served, at, {
      resolverVersion: RESOLVER_VERSION,
      evaluatedAt: new Date(),
    });
    reply.header("Content-Type", "application/json");
    reply.header("Cache-Control", "public, max-age=60");
    const licenses = new Set(projected.conditions.map((c) => c.routing_evidence.source_license));
    reply.header("X-Data-License", licenses.size > 0 ? [...licenses].sort().join(", ") : "unknown");
    return reply.send(projected);
  });

  registerFeedStatusRoute(
    app,
    statusStore,
    catalog,
    createBindingMetricsReader(sql),
    () => readSourceOperationalStatus(sql),
    () => readFeedGraphStatus(sql),
  );
}
