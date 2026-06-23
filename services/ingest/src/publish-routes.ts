import { type ConditionEvent, readObservations } from "@openconditions/core";
import {
  diffObservations,
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
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";

type Sql = postgres.Sql;
type BBox = [number, number, number, number];

/** How often the SSE stream re-polls the store for changes + heartbeats. */
const STREAM_POLL_MS = 15_000;

const FEED_BASE: Omit<FeedInfo, "timestamp"> = {
  attribution: "OpenConditions",
  url: "https://openconditions.org",
  license: "mixed (per source)",
};

function parseBbox(raw: string | undefined): BBox | null {
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
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

/**
 * Public emitter endpoints — read-only projections of conditions.observations
 * into standard wire formats so the wider ecosystem can consume OpenConditions:
 *   GET /observations.geojson · /observations.jsonld · /traff.xml ·
 *       /gtfs-rt/alerts.pb · /datex2/situations.xml · /stream (SSE)
 * All bbox-filterable (?bbox=west,south,east,north[&domain=roads]); /stream also
 * takes an optional comma-separated &type= filter and pushes live deltas.
 */
export function registerPublishRoutes(app: FastifyInstance, sql: Sql): void {
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
}
