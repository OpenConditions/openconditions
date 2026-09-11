import {
  type ConditionEvent,
  type Measurement,
  type Observation,
  type RoutingRights,
  readObservations,
} from "@openconditions/core";
import {
  diffObservations,
  segmentConditionsToExclusions,
  filterForPermissiveExport,
  flowToSegmentSpeedCsv,
  isPermissiveLicense,
  matchesTypeFilter,
  observationsToDatexSituations,
  parseTypeFilter,
  segmentConditionsToJson,
  segmentsToGeoJSON,
  sseFrame,
  type FeedInfo,
  type SegmentConditionRow,
  type SegmentSpeedCsvRow,
  type SegmentSpeedRow,
  observationsToGeoJSON,
  observationsToGtfsRtAlerts,
  observationsToJsonLd,
  observationsToOccupancy,
  observationsToTraff,
} from "@openconditions/publishers";
import {
  hasCredentials,
  requiredEnvVars,
  type DomainRegistry,
  type DatasetRights,
} from "@openconditions/ingest-framework";
import { RESOLVER_VERSION } from "@openconditions/roads";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { FeedRunStatus, FeedStatusStore } from "./feed-status.js";
import {
  readSourceOperationalStatus,
  type SourceOperationalStatus,
  type SourceStatusReader,
} from "./pipeline/source-status.js";
import {
  createBindingMetricsReader,
  type BindingMetrics,
  type BindingMetricsReader,
} from "./pipeline/binding-metrics.js";

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
          : null
    )
    .filter((region): region is string => region != null);
  return {
    generation: row.generation,
    status: row.status === "ready" && regions.length > 0 ? "ready" : "partial",
    regions,
  };
}

/** How often the SSE stream re-polls the store for changes + heartbeats. */
const STREAM_POLL_MS = 15_000;

const FEED_BASE: Omit<FeedInfo, "timestamp"> = {
  attribution: "OpenConditions",
  url: "https://openconditions.org",
  license: "mixed (per source)",
};

function grant(value: boolean | null | undefined): "yes" | "no" | "unknown" {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}

function fullIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function routingRights(rights: DatasetRights | RoutingRights | null | undefined) {
  if (!rights) return null;
  if ("source_redistribution" in rights) {
    return {
      ...rights,
      reviewed_at: fullIso(rights.reviewed_at),
    };
  }
  return {
    source_redistribution: grant(rights.sourceRedistribution),
    derived_redistribution: grant(rights.derivedRedistribution),
    commercial_use: grant(rights.commercialUse),
    attribution_required: grant(rights.attributionRequired),
    retention: grant(rights.retention),
    evidence_origin: rights.evidenceOrigin ?? null,
    evidence_version: rights.evidenceVersion ?? null,
    reviewed_at: fullIso(rights.reviewedAt),
  } as const;
}

function hydrateSegmentRows(
  rows: SegmentConditionRow[],
  registry: DomainRegistry
): SegmentConditionRow[] {
  const feedById = new Map(
    Object.values(registry).flatMap((domain) =>
      domain.feeds.map((feed) => [feed.id, feed] as const)
    )
  );
  return rows
    .filter((row) => isPermissiveLicense(row.source_license))
    .map((row) => {
      const feed = feedById.get(row.source);
      const attribution = row.origin.attribution as
        | {
            provider?: string;
            url?: string;
            rights?: DatasetRights | RoutingRights;
            parentSourceId?: string;
          }
        | undefined;
      const parentSourceId = feed?.parentSourceId ?? attribution?.parentSourceId;
      return {
        ...row,
        routing_source_id: parentSourceId ?? row.source,
        child_source_id: parentSourceId ? row.source : null,
        license_url: feed?.licenseUrl ?? attribution?.url ?? null,
        attribution: attribution?.provider ?? feed?.attribution ?? null,
        rights: routingRights(attribution?.rights ?? feed?.rights),
      };
    });
}

/**
 * Parse a `west,south,east,north` query param into a BBox, rejecting malformed
 * or out-of-domain input rather than silently substituting a wrong value.
 *
 * NOTE: this is a byte-identical copy of `parseBbox` in OpenMapX's
 * `integrations/road-conditions/index.ts` — there is no shared package either
 * side imports from, so any future change here must be mirrored there too.
 */
export function parseBbox(raw: string | undefined): BBox | null {
  if (!raw) return null;
  const segments = raw.split(",");
  // Reject blank segments explicitly — `Number("")` is `0` (finite), so
  // "1,,3,4" would otherwise silently parse to [1, 0, 3, 4] instead of
  // being rejected as malformed.
  if (segments.length !== 4 || segments.some((s) => s.trim() === "")) return null;
  const parts = segments.map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts as BBox;
  if (west < -180 || west > 180 || east < -180 || east > 180) return null;
  if (south < -90 || south > 90 || north < -90 || north > 90) return null;
  if (south > north) return null;
  // west > east would describe an antimeridian-crossing box; those are not
  // supported downstream (bbox intersection assumes west <= east), so reject
  // rather than silently returning empty/wrong results.
  if (west > east) return null;
  return parts as BBox;
}

/** The canonical severity ladder, for validating `?minSeverity=`. */
const SEVERITY_VALUES = ["low", "medium", "high", "critical"] as const;

/** `?types=roadworks,road_closure` → the read filter, or null when unusable. */
function parseTypesParam(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const types = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return types.length > 0 ? types : null;
}

/** `?minSeverity=high` → the read filter; an unknown value reads as absent. */
function parseMinSeverityParam(raw: string | undefined): string | null {
  if (!raw) return null;
  return (SEVERITY_VALUES as readonly string[]).includes(raw) ? raw : null;
}

/**
 * `?horizonDays=7` → "in effect within a week". Anything that is not a
 * non-negative integer (including `-1` and `abc`) reads as absent, i.e. no
 * temporal filter at all — never as `0`, which would silently hide every
 * announced future condition.
 */
function parseHorizonDaysParam(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Distinct `origin.attribution.license` ids present in an observation set, for
 * the `X-Data-License` response header. Called on an already
 * `filterForPermissiveExport`-filtered set, so this is bounded (a handful of
 * permissive ids at most, never the raw per-feed cardinality of every source).
 */
function distinctLicenses(obs: Observation[]): string {
  const licenses = new Set<string>();
  for (const o of obs) {
    if (o.origin.attribution.license) licenses.add(o.origin.attribution.license);
  }
  return licenses.size > 0 ? [...licenses].join(", ") : "unknown";
}

/**
 * Shallow-copies an observation with `sourceRaw` omitted, mirroring the
 * GeoJSON route's `?raw=1` gating for `/stream`. Never mutates `o` — the SSE
 * diff poller (`prev`/`next` maps in the `/stream` handler) keeps reusing the
 * same observation objects across polls.
 */
function withoutSourceRaw(o: Observation): Observation {
  const withRaw = o as Observation & { sourceRaw?: unknown };
  if (withRaw.sourceRaw === undefined) return o;
  const { sourceRaw: _sourceRaw, ...rest } = withRaw;
  return rest as Observation;
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

/**
 * Half-width, in metres, of the geometry emitted for a POINT-located binding.
 * A point event binds to a span with `start_fraction = end_fraction`, and
 * `ST_LineSubstring` on a zero-length range returns a GeoJSON `Point`, which
 * would break the emitter's `LineString | null` contract. Widening the CUT by
 * 10 m either side keeps the consumer's map-matching input a line while the
 * emitted fractions stay equal and truthful about where the event actually is.
 */
const POINT_SPAN_HALF_M = 10;

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
  rights?: import("@openconditions/ingest-framework").DatasetRights;
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
 * Registers `GET /feeds/status`: every feed registered across all domains,
 * joined with its runtime status (last run/success/error, row count) and with
 * how well its events bind to the segment spine. Mirrors the scheduler's own
 * credential check (a feed runs iff it has credentials) so the two never
 * disagree.
 *
 * The binding metrics are a read-only extra, so a failing metrics query is
 * logged and the listing is still served — just without `binding` keys.
 */
export function registerFeedStatusRoute(
  app: FastifyInstance,
  statusStore: FeedStatusStore,
  registry: DomainRegistry,
  bindingMetrics: BindingMetricsReader,
  sourceStatus?: SourceStatusReader,
  graphStatus?: FeedGraphStatusReader
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
    for (const [domain, plugin] of Object.entries(registry)) {
      for (const feed of plugin.feeds) {
        // Check each candidate key independently (auth: undefined) so a
        // multi-var auth (basic/oauth2/mtls) with only one var unset reports
        // just that key, not every key hasCredentials would re-derive from
        // feed.auth as a whole.
        const missingEnv = [...requiredEnvVars(feed.auth), ...(feed.requiredEnv ?? [])].filter(
          (k) => !hasCredentials({ auth: undefined, requiredEnv: [k] })
        );
        const binding = metrics.get(feed.id);
        const persisted = durable.get(feed.id);
        feeds.push({
          id: feed.id,
          name: feed.name,
          domain,
          hasCredentials: hasCredentials(feed),
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
      for (const feed of plugin.discoveredFeeds ?? []) {
        feeds.push({
          id: feed.id,
          name: feed.name,
          domain,
          hasCredentials: false,
          missingEnv: [],
          selectionState: "discovered",
          parentSourceId: feed.parentSourceId,
          cadenceSec: feed.cadenceSec,
          freshnessWindowSec: feed.freshnessWindowSec,
          rights: feed.rights,
        });
      }
    }
    return { schemaVersion: "2.0", instanceId: "openconditions", collectedAt, graph, feeds };
  });
}

/**
 * Public emitter endpoints — read-only projections of conditions.observations
 * into standard wire formats so the wider ecosystem can consume OpenConditions:
 *   GET /observations.geojson · /observations.jsonld · /traff.xml ·
 *       /gtfs-rt/alerts.pb · /gtfs-rt/occupancy.pb · /datex2/situations.xml ·
 *       /valhalla/exclusions.json · /stream (SSE) · /feeds/status ·
 *       /segments.geojson · /segments/speed.csv · /segments/profiles.json ·
 *       /segments/conditions.json
 * All bbox-filterable (?bbox=west,south,east,north[&domain=roads]); /stream also
 * takes an optional comma-separated &type= filter and pushes live deltas.
 *
 * `/segments.geojson` is a projection of `conditions.road_segment` (LEFT JOIN
 * `segment_speed`), not of `conditions.observations`, so unlike the routes
 * above it does NOT run `filterForPermissiveExport`. `segment_speed` is a fused
 * product; for a segment with a single contributing source it is effectively
 * that source's own reading, so skipping the license filter is only safe while
 * no share-alike source feeds the surface. That holds for v1: the current
 * share-alike feeds are event/roadworks feeds (`kind: "event"`), not
 * `metric: "flow"` measurements, so they never contribute to `segment_speed`.
 * Follow-up when a share-alike FLOW source is ever added: filter segments by the
 * licenses of their contributing sources (`segment_speed.contributing` carries
 * the source ids) before emitting here.
 */
export function registerPublishRoutes(
  app: FastifyInstance,
  sql: Sql,
  statusStore: FeedStatusStore,
  registry: DomainRegistry
): void {
  const db = runner(sql);

  // Every route funnelling through `read()` is a redistributable export
  // (see the module doc comment above), so share-alike records are dropped
  // here, once, for all of them.
  // `defaultDomain` is the domain used when the request carries no `?domain=`.
  // Pass `null` to read across ALL domains (the GTFS-RT alerts route needs this).
  // Note: `null`, not `undefined` — an explicit `undefined` argument would
  // re-trigger the `"roads"` default and silently scope the read back to roads.
  const read = async (
    q: Record<string, string | undefined>,
    defaultDomain: string | null = "roads"
  ) => {
    const bbox = parseBbox(q.bbox);
    if (!bbox) return null;
    const domain = q.domain ?? defaultDomain ?? undefined;
    const types = parseTypesParam(q.types);
    const minSeverity = parseMinSeverityParam(q.minSeverity);
    const horizonDays = parseHorizonDaysParam(q.horizonDays);
    const obs = await readObservations(db, {
      domain,
      bbox,
      ...(types ? { types } : {}),
      ...(minSeverity ? { minSeverity } : {}),
      ...(horizonDays != null ? { horizonDays } : {}),
      // The GeoJSON export spreads the whole model, so bound events publish
      // their binding + segments. The XML emitters and the Valhalla exclusions
      // project named fields and ignore the extra ones.
      includeBindings: true,
    });
    return filterForPermissiveExport(obs);
  };
  const info = (): FeedInfo => ({ ...FEED_BASE, timestamp: new Date().toISOString() });

  app.get("/observations.geojson", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const obs = await read(q);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    reply.header("Content-Type", "application/geo+json");
    reply.header("Cache-Control", "public, max-age=90");
    reply.header("X-Data-License", distinctLicenses(obs));
    // ?raw=1 includes the verbatim sourceRaw passthrough (larger payload).
    return reply.send(observationsToGeoJSON(obs, info(), { includeRaw: q.raw === "1" }));
  });

  app.get("/observations.jsonld", async (req, reply) => {
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    reply.header("Content-Type", "application/ld+json");
    reply.header("Cache-Control", "public, max-age=90");
    reply.header("X-Data-License", distinctLicenses(obs));
    return reply.send(observationsToJsonLd(obs, info()));
  });

  app.get("/traff.xml", async (req, reply) => {
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const events = obs.filter((o): o is ConditionEvent => o.kind === "event");
    reply.header("Content-Type", "application/xml; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=90");
    reply.header("X-Data-License", distinctLicenses(obs));
    return reply.send(observationsToTraff(events));
  });

  app.get("/gtfs-rt/alerts.pb", async (req, reply) => {
    // A GTFS-RT Alert is dataset-scoped, not road-scoped: read across ALL
    // domains (unless one is explicitly requested) so transit-affecting events
    // from any domain are considered, then let the emitter's selector gate drop
    // everything without a concrete transit entity.
    const obs = await read(req.query as Record<string, string | undefined>, null);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const events = obs.filter((o): o is ConditionEvent => o.kind === "event");
    const pb = observationsToGtfsRtAlerts(events, { timestamp: new Date().toISOString() });
    reply.header("Content-Type", "application/x-protobuf");
    reply.header("Cache-Control", "public, max-age=90");
    reply.header("X-Data-License", distinctLicenses(obs));
    return reply.send(Buffer.from(pb));
  });

  app.get("/gtfs-rt/occupancy.pb", async (req, reply) => {
    // EXPERIMENTAL GTFS-RT OccupancyStatus feed. Reads `transit/occupancy`
    // Measurements across ALL domains (like the alerts route), then lets the
    // emitter's concrete-entity gate keep only trip+vehicle / trip+stop_sequence
    // occupancy and drop route/stop aggregates. There is NO occupancy data
    // source wired in this repo today, so this honestly serves an empty feed
    // until one is added — a valid, decodable, entity-less FeedMessage.
    const obs = await read(req.query as Record<string, string | undefined>, null);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const measurements = obs.filter(
      (o): o is Measurement => o.kind === "measurement" && (o as Measurement).metric === "occupancy"
    );
    const pb = observationsToOccupancy(measurements, { timestamp: new Date().toISOString() });
    reply.header("Content-Type", "application/x-protobuf");
    reply.header("Cache-Control", "public, max-age=90");
    reply.header("X-Data-License", distinctLicenses(obs));
    return reply.send(Buffer.from(pb));
  });

  app.get("/datex2/situations.xml", async (req, reply) => {
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const events = obs.filter((o): o is ConditionEvent => o.kind === "event");
    reply.header("Content-Type", "application/xml; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=90");
    reply.header("X-Data-License", distinctLicenses(obs));
    return reply.send(observationsToDatexSituations(events, info()));
  });

  app.get("/valhalla/exclusions.json", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const bbox = parseBbox(q.bbox);
    if (!bbox) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const at = q.at ? new Date(q.at) : new Date();
    if (Number.isNaN(at.getTime())) {
      return reply.status(400).send({ error: "at must be an ISO 8601 timestamp" });
    }
    const [west, south, east, north] = bbox;
    const raw = await db.execute<SegmentConditionRow[]>(
      `SELECT o.id, o.source, o.type, o.severity, o.attributes, o.origin, o.routing_eligible,
              o.valid_from, o.valid_to, o.schedule, o.source_license, o.source_uri, o.expires_at,
              o.content_hash AS observation_revision,
              ss.last_network_success_at AS source_checked_at,
              ss.freshness_deadline AS fresh_until,
              b.status AS binding_status, b.confidence AS binding_confidence,
              b.resolver_version AS binding_resolver_version,
              b.direction_mode AS binding_direction_mode,
              b.observation_revision AS binding_revision, b.graph_generation,
              COALESCE(seg.segments, '[]'::jsonb) AS segments
       FROM conditions.observations o
       JOIN conditions.observation_binding b ON b.observation_id=o.id
       JOIN conditions.road_graph_state graph ON graph.singleton AND graph.status='ready'
         AND graph.generation=b.graph_generation
       LEFT JOIN conditions.source_status ss ON ss.source=o.source
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('segmentId',s.segment_id,'wayId',s.way_id,
                  'dir',s.dir,'startFraction',s.start_fraction,'endFraction',s.end_fraction,
                  'geometry',CASE WHEN rs.geom IS NULL THEN NULL
                    ELSE ST_AsGeoJSON(ST_LineSubstring(rs.geom,
                      LEAST(s.start_fraction,s.end_fraction),GREATEST(s.start_fraction,s.end_fraction)))::jsonb END)
                  ORDER BY s.seq) AS segments
         FROM conditions.observation_segment s
         LEFT JOIN conditions.road_segment rs ON rs.segment_id=s.segment_id
         WHERE s.observation_id=o.id) seg ON true
       WHERE o.kind='event' AND o.domain='roads' AND o.status='active'
         AND o.geom && ST_MakeEnvelope($1,$2,$3,$4,4326)
         AND b.status IN ('exact','likely') AND b.resolver_version=$6
         AND (o.valid_to IS NULL OR o.valid_to > $5::timestamptz)
         AND (o.expires_at IS NULL OR o.expires_at > now())
       ORDER BY o.id`,
      [west, south, east, north, at.toISOString(), RESOLVER_VERSION]
    );
    const evaluatedAt = new Date();
    const rows = hydrateSegmentRows(raw, registry);
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
        .filter(Number.isFinite)
    );
    const maxAge =
      deadlines.length === 0
        ? 0
        : Math.max(
            0,
            Math.min(90, Math.floor((Math.min(...deadlines) - evaluatedAt.getTime()) / 1000))
          );
    reply.header("Cache-Control", `public, max-age=${maxAge}`);
    const licenses = new Set(projected.conditions.map((c) => c.routing_evidence.source_license));
    reply.header("X-Data-License", licenses.size > 0 ? [...licenses].join(", ") : "unknown");
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
       LEFT JOIN conditions.segment_speed sp USING (segment_id)
       WHERE s.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
       LIMIT 20000`,
      [west, south, east, north]
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
  app.get("/segments/speed.csv", async (_req, reply) => {
    const rows = await db.execute<SegmentSpeedCsvRow[]>(
      `SELECT rs.way_id AS "wayId", rs.dir, sp.current_kph AS "currentKph",
              sp.free_flow_kph AS "freeFlowKph", sp.los
       FROM conditions.segment_speed sp
       JOIN conditions.road_segment rs USING (segment_id)
       WHERE sp.current_kph IS NOT NULL`
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
  app.get("/segments/profiles.json", async (_req, reply) => {
    const rows = await db.execute<SegmentProfileBucketRow[]>(
      `SELECT rs.segment_id AS "segmentId", rs.way_id AS "wayId", rs.dir,
              rs.free_flow_kph AS "freeFlowKph",
              sp.dow, sp.tod_hour AS "todHour", sp.speed_kph AS "speedKph"
       FROM conditions.segment_profile sp
       JOIN conditions.road_segment rs USING (segment_id)
       ORDER BY rs.segment_id`
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
          v != null && i % 24 >= DAYTIME_START_HOUR && i % 24 <= DAYTIME_END_HOUR
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

  // Routing feed of BOUND conditions in effect at `at` (default now): closures
  // and speed limits keyed by directed OSM way spans, for the OpenMapX live
  // traffic writer. Share-alike records are dropped like every other export.
  //
  // Only `exact`/`likely`/`ambiguous` bindings are emitted -- everything below
  // that has no span to key on. The per-span `geometry` is the occupied part of
  // the directed segment cut in travel direction (`road_segment.geom` is
  // already reversed for `dir = 'b'`); the binding tables have no FK to
  // `road_segment`, so a span whose segment a spine rebuild has dropped comes
  // through the LEFT JOIN as `geometry: null` rather than vanishing. A
  // point-located event binds to a zero-length span, whose geometry is widened
  // to a short line (see POINT_SPAN_HALF_M) so `geometry` is always a
  // LineString or null, never a Point.
  app.get("/segments/conditions.json", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const at = q.at ? new Date(q.at) : new Date();
    if (Number.isNaN(at.getTime())) {
      return reply.status(400).send({ error: "at must be an ISO 8601 timestamp" });
    }
    const rows = await db.execute<SegmentConditionRow[]>(
      `SELECT o.id, o.source, o.type, o.severity, o.attributes, o.origin, o.routing_eligible,
              o.valid_from, o.valid_to, o.schedule, o.source_license, o.source_uri, o.expires_at,
              o.content_hash AS observation_revision,
              ss.last_network_success_at AS source_checked_at,
              ss.freshness_deadline AS fresh_until,
              b.status AS binding_status, b.confidence AS binding_confidence,
              b.resolver_version AS binding_resolver_version,
              b.direction_mode AS binding_direction_mode,
              b.observation_revision AS binding_revision,
              b.graph_generation,
              COALESCE(seg.segments, '[]'::jsonb) AS segments
       FROM conditions.observations o
       JOIN conditions.observation_binding b ON b.observation_id = o.id
       JOIN conditions.road_graph_state graph ON graph.singleton AND graph.status='ready'
         AND graph.generation=b.graph_generation
       LEFT JOIN conditions.source_status ss ON ss.source = o.source
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('segmentId', s.segment_id,
                  'wayId', s.way_id, 'dir', s.dir,
                  'startFraction', s.start_fraction, 'endFraction', s.end_fraction,
                  'geometry', CASE
                    WHEN rs.geom IS NULL THEN NULL
                    WHEN s.start_fraction = s.end_fraction THEN
                      CASE WHEN rs.length_m > 0
                           THEN ST_AsGeoJSON(ST_LineSubstring(rs.geom,
                                  GREATEST(0, s.start_fraction - (${POINT_SPAN_HALF_M})::double precision / rs.length_m),
                                  LEAST(1, s.start_fraction + (${POINT_SPAN_HALF_M})::double precision / rs.length_m)))::jsonb
                           ELSE NULL END
                    ELSE ST_AsGeoJSON(ST_LineSubstring(rs.geom,
                           LEAST(s.start_fraction, s.end_fraction),
                           GREATEST(s.start_fraction, s.end_fraction)))::jsonb END)
                  ORDER BY s.seq) AS segments
         FROM conditions.observation_segment s
         LEFT JOIN conditions.road_segment rs ON rs.segment_id = s.segment_id
         WHERE s.observation_id = o.id) seg ON true
       WHERE o.kind = 'event' AND o.domain = 'roads' AND o.status = 'active'
         AND b.status IN ('exact','likely') AND b.resolver_version=$2
         AND (o.valid_to IS NULL OR o.valid_to > $1::timestamptz)
         AND (o.expires_at IS NULL OR o.expires_at > now())
       ORDER BY o.id`,
      [at.toISOString(), RESOLVER_VERSION]
    );
    const permissive = hydrateSegmentRows(rows, registry);
    reply.header("Content-Type", "application/json");
    reply.header("Cache-Control", "public, max-age=60");
    // Same shape as `distinctLicenses`, but read off the `source_license`
    // column rather than a parsed Observation -- including its "unknown"
    // fallback, so the header is never sent as an empty string.
    const licenses = new Set(permissive.map((r) => r.source_license ?? "unknown"));
    reply.header("X-Data-License", licenses.size > 0 ? [...licenses].join(", ") : "unknown");
    return reply.send(
      segmentConditionsToJson(permissive, at, {
        resolverVersion: RESOLVER_VERSION,
        evaluatedAt: new Date(),
      })
    );
  });

  app.get("/stream", (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const bbox = parseBbox(q.bbox);
    if (!bbox) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const domain = q.domain ?? "roads";
    const types = parseTypeFilter(q.type);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // The stream can't enumerate a distinct license list up front (future
      // ticks may add sources), but every record it ever emits is
      // permissive-filtered below, so this static notice is accurate.
      "X-Data-License": "permissive (share-alike filtered)",
    });

    let prev = new Map<string, string>();
    const tick = async () => {
      try {
        const obs = filterForPermissiveExport(await readObservations(db, { domain, bbox })).filter(
          (o) => matchesTypeFilter(o, types)
        );
        const { changed, removed, next } = diffObservations(prev, obs);
        prev = next;
        for (const o of changed) {
          // ?raw=1 includes the verbatim sourceRaw passthrough, mirroring the
          // GeoJSON route's gating (larger payload).
          const data = q.raw === "1" ? o : withoutSourceRaw(o);
          reply.raw.write(sseFrame({ event: "condition", id: o.id, data }));
        }
        for (const id of removed) {
          reply.raw.write(sseFrame({ event: "remove", data: { id } }));
        }
      } catch (err) {
        req.log.error(err, "[stream] poll failed");
      }
    };

    void tick(); // initial snapshot
    const poll = setInterval(() => void tick(), STREAM_POLL_MS);
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), STREAM_POLL_MS);
    req.raw.on("close", () => {
      clearInterval(poll);
      clearInterval(heartbeat);
    });
    return reply;
  });

  registerFeedStatusRoute(
    app,
    statusStore,
    registry,
    createBindingMetricsReader(sql),
    () => readSourceOperationalStatus(sql),
    () => readFeedGraphStatus(sql)
  );
}
