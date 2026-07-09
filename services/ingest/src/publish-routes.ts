import { type ConditionEvent, type Observation, readObservations } from "@openconditions/core";
import {
  diffObservations,
  eventsToExclusions,
  filterForPermissiveExport,
  flowToSegmentSpeedCsv,
  matchesTypeFilter,
  observationsToDatexSituations,
  parseTypeFilter,
  segmentsToGeoJSON,
  sseFrame,
  type FeedInfo,
  type SegmentSpeedCsvRow,
  type SegmentSpeedRow,
  observationsToGeoJSON,
  observationsToGtfsRtAlerts,
  observationsToJsonLd,
  observationsToTraff,
} from "@openconditions/publishers";
import {
  hasCredentials,
  requiredEnvVars,
  type DomainRegistry,
} from "@openconditions/ingest-framework";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { FeedRunStatus, FeedStatusStore } from "./feed-status.js";

type Sql = postgres.Sql;
type BBox = [number, number, number, number];

/** How often the SSE stream re-polls the store for changes + heartbeats. */
const STREAM_POLL_MS = 15_000;

const FEED_BASE: Omit<FeedInfo, "timestamp"> = {
  attribution: "OpenConditions",
  url: "https://openconditions.org",
  license: "mixed (per source)",
};

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
  enabled: boolean;
  hasCredentials: boolean;
  missingEnv: string[];
} & FeedRunStatus;

/**
 * Registers `GET /feeds/status`: every feed registered across all domains,
 * joined with its runtime status (last run/success/error, row count). Mirrors
 * the scheduler's own enabled/credential checks so the two never disagree.
 */
export function registerFeedStatusRoute(
  app: FastifyInstance,
  statusStore: FeedStatusStore,
  registry: DomainRegistry
): void {
  app.get("/feeds/status", async () => {
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
        feeds.push({
          id: feed.id,
          name: feed.name,
          domain,
          enabled: feed.enabledByDefault,
          hasCredentials: hasCredentials(feed),
          missingEnv,
          ...(statusStore.get(feed.id) ?? {}),
        });
      }
    }
    return { feeds };
  });
}

/**
 * Public emitter endpoints — read-only projections of conditions.observations
 * into standard wire formats so the wider ecosystem can consume OpenConditions:
 *   GET /observations.geojson · /observations.jsonld · /traff.xml ·
 *       /gtfs-rt/alerts.pb · /datex2/situations.xml ·
 *       /valhalla/exclusions.json · /stream (SSE) · /feeds/status ·
 *       /segments.geojson · /segments/speed.csv · /segments/profiles.json
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
  const read = async (q: Record<string, string | undefined>) => {
    const bbox = parseBbox(q.bbox);
    if (!bbox) return null;
    const obs = await readObservations(db, { domain: q.domain ?? "roads", bbox });
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
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const events = obs.filter((o): o is ConditionEvent => o.kind === "event");
    const pb = observationsToGtfsRtAlerts(events, { timestamp: new Date().toISOString() });
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
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    reply.header("Content-Type", "application/json");
    reply.header("Cache-Control", "public, max-age=90");
    reply.header("X-Data-License", distinctLicenses(obs));
    return reply.send(eventsToExclusions(obs));
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

  registerFeedStatusRoute(app, statusStore, registry);
}
