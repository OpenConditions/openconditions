import { type ConditionEvent, readObservations } from "@openconditions/core";
import {
  type FeedInfo,
  observationsToGeoJSON,
  observationsToJsonLd,
  observationsToTraff,
} from "@openconditions/publishers";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";

type Sql = postgres.Sql;
type BBox = [number, number, number, number];

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
 *   GET /observations.geojson  · GET /observations.jsonld  · GET /traff.xml
 * All bbox-filterable (?bbox=west,south,east,north[&domain=roads]).
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
    const obs = await read(req.query as Record<string, string | undefined>);
    if (!obs) return reply.status(400).send({ error: "bbox required: west,south,east,north" });
    reply.header("Content-Type", "application/geo+json");
    reply.header("Cache-Control", "public, max-age=90");
    return reply.send(observationsToGeoJSON(obs, info()));
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
}
