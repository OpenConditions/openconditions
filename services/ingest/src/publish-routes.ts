import { type ConditionEvent, readObservations } from "@openconditions/core";
import {
  diffObservations,
  eventsToExclusions,
  matchesTypeFilter,
  observationsToDatexSituations,
  parseTypeFilter,
  sseFrame,
  type FeedInfo,
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
 *       /valhalla/exclusions.json · /stream (SSE) · /feeds/status
 * All bbox-filterable (?bbox=west,south,east,north[&domain=roads]); /stream also
 * takes an optional comma-separated &type= filter and pushes live deltas.
 */
export function registerPublishRoutes(
  app: FastifyInstance,
  sql: Sql,
  statusStore: FeedStatusStore,
  registry: DomainRegistry
): void {
  const db = runner(sql);

  const read = (q: Record<string, string | undefined>) => {
    const bbox = parseBbox(q.bbox);
    if (!bbox) return null;
    return readObservations(db, { domain: q.domain ?? "roads", bbox });
  };
  const info = (): FeedInfo => ({ ...FEED_BASE, timestamp: new Date().toISOString() });

  app.get("/observations.geojson", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const obs = await read(q);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    reply.header("Content-Type", "application/geo+json");
    reply.header("Cache-Control", "public, max-age=90");
    // ?raw=1 includes the verbatim sourceRaw passthrough (larger payload).
    return reply.send(observationsToGeoJSON(obs, info(), { includeRaw: q.raw === "1" }));
  });

  app.get("/observations.jsonld", async (req, reply) => {
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    reply.header("Content-Type", "application/ld+json");
    reply.header("Cache-Control", "public, max-age=90");
    return reply.send(observationsToJsonLd(obs, info()));
  });

  app.get("/traff.xml", async (req, reply) => {
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const events = obs.filter((o): o is ConditionEvent => o.kind === "event");
    reply.header("Content-Type", "application/xml; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=90");
    return reply.send(observationsToTraff(events));
  });

  app.get("/gtfs-rt/alerts.pb", async (req, reply) => {
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const events = obs.filter((o): o is ConditionEvent => o.kind === "event");
    const pb = observationsToGtfsRtAlerts(events, { timestamp: new Date().toISOString() });
    reply.header("Content-Type", "application/x-protobuf");
    reply.header("Cache-Control", "public, max-age=90");
    return reply.send(Buffer.from(pb));
  });

  app.get("/datex2/situations.xml", async (req, reply) => {
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    const events = obs.filter((o): o is ConditionEvent => o.kind === "event");
    reply.header("Content-Type", "application/xml; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=90");
    return reply.send(observationsToDatexSituations(events, info()));
  });

  app.get("/valhalla/exclusions.json", async (req, reply) => {
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    reply.header("Content-Type", "application/json");
    reply.header("Cache-Control", "public, max-age=90");
    return reply.send(eventsToExclusions(obs));
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
    });

    let prev = new Map<string, string>();
    const tick = async () => {
      try {
        const obs = (await readObservations(db, { domain, bbox })).filter((o) =>
          matchesTypeFilter(o, types)
        );
        const { changed, removed, next } = diffObservations(prev, obs);
        prev = next;
        for (const o of changed) {
          reply.raw.write(sseFrame({ event: "condition", id: o.id, data: o }));
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
