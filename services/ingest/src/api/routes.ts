import {
  dedupeSituations,
  listSituations,
  type QueryRunner,
  readCoverage,
} from "@openconditions/core";
import { readRecord, readRevisions } from "@openconditions/core/server";
import { jsonSchemaArtifacts, type Registry } from "@openconditions/model";
import {
  type EgressRecord,
  type FeedInfo,
  isPermissiveRecord,
  nextEffectTransition,
  permissiveRecords,
  situationsToDatex,
  situationsToGeoJSON,
  situationsToJsonLd,
  situationsToTraff,
} from "@openconditions/publishers";
import type { FastifyInstance, FastifyReply } from "fastify";
import type postgres from "postgres";
import type { z } from "zod";
import { startRecordStream } from "../record-stream.js";
import { openApiDocument } from "./openapi.js";
import { AtQuery, queryError, RecordClassParam, SituationListQuery, StreamQuery } from "./query.js";
import { taxonomyOf } from "./taxonomy.js";

type Rec = Record<string, unknown>;

/** The longest a collection may be cached: a feed refreshes within minutes. */
const MAX_CACHE_SECONDS = 90;

/** Live streams open at once, `STREAM_MAX_CONNECTIONS` (default 100). */
function streamMaxConnectionsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env["STREAM_MAX_CONNECTIONS"]);
  return Number.isInteger(n) && n > 0 ? n : 100;
}

/** The stream reads in pages of this size, and holds at most `STREAM_MAX` situations. */
const STREAM_PAGE = 5000;
const STREAM_MAX = 20_000;

const FEED_INFO: FeedInfo = {
  attribution: "OpenConditions",
  url: "https://openconditions.org",
  license: "mixed (per source)",
};

/** The distinct licences of `records`, for `X-Data-License`. */
function licensesOf(records: readonly Rec[]): string {
  const licenses = new Set(
    records.map((r) => (r as unknown as EgressRecord).provenance.attribution.license),
  );
  return licenses.size > 0 ? [...licenses].sort().join(", ") : "none";
}

/**
 * Caches a response until its first effect changes state, at most
 * `MAX_CACHE_SECONDS`: a closure starting in a minute must not be served as
 * absent for longer than that.
 */
function cacheFor(reply: FastifyReply, records: readonly Rec[], at: Date): void {
  const next = nextEffectTransition(records, at);
  const seconds =
    next === null
      ? MAX_CACHE_SECONDS
      : Math.min(MAX_CACHE_SECONDS, Math.floor((Date.parse(next) - Date.now()) / 1000));
  reply.header("Cache-Control", seconds > 0 ? `public, max-age=${seconds}` : "no-store");
}

/** The reader filters a collection or stream query names. */
function filtersOf(q: StreamQuery) {
  return {
    ...(q.bbox ? { bbox: q.bbox } : {}),
    ...(q.kind ? { kinds: q.kind } : {}),
    ...(q.type ? { types: q.type } : {}),
    ...(q.domain ? { domain: q.domain } : {}),
    ...(q.source ? { sources: q.source } : {}),
    ...(q.origin ? { origins: q.origin } : {}),
    ...(q.minSeverity ? { minSeverity: q.minSeverity } : {}),
  };
}

/**
 * Links the next page of an XML collection, which has no body field for it:
 * the request's own query with the cursor replaced.
 */
function linkNext(reply: FastifyReply, url: string, next: string | null): void {
  if (next === null) return;
  const [path, query = ""] = url.split("?", 2) as [string, string?];
  const kept = query.split("&").filter((p) => p !== "" && !p.startsWith("cursor="));
  kept.push(`cursor=${encodeURIComponent(next)}`);
  reply.header("Link", `<${path}?${kept.join("&")}>; rel="next"`);
}

/**
 * Parses `value` with `schema`, or answers 400 with the issues and returns
 * undefined.
 */
function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
): z.output<S> | undefined {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  void reply.status(400).send(queryError(result.error));
  return undefined;
}

/**
 * The record API: situation collections (JSON, GeoJSON, JSON-LD) paginated
 * by a keyset cursor, one situation with its evidence and binding, a
 * record's history, the registry's taxonomy and JSON Schemas, coverage and
 * the OpenAPI document. Every record leaves through the licence egress:
 * share-alike records are withheld and a crowd reporter's key is stripped.
 */
export function registerApiRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  deps: { registry: Registry; streamPollMs?: number; streamMaxConnections?: number },
): void {
  const db: QueryRunner = {
    execute: async <T>(query: string, params?: unknown[]) =>
      (await sql.unsafe(query, params as never)) as T,
  };
  let artifacts: Map<string, unknown> | undefined;
  let taxonomy: ReturnType<typeof taxonomyOf> | undefined;

  /** One page of situations as the egress serves them, and the instant they were read at. */
  async function page(q: z.output<typeof SituationListQuery>) {
    const at = q.at ? new Date(q.at) : new Date();
    const read = await listSituations(db, {
      at,
      limit: q.limit,
      ...filtersOf(q),
      ...(q.horizonDays !== undefined ? { horizonDays: q.horizonDays } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    const permissive = permissiveRecords(
      read.records as unknown as EgressRecord[],
    ) as unknown as Rec[];
    const records = q.dedupe === "1" ? dedupeSituations(permissive) : permissive;
    return { at, records, next: read.next };
  }

  /** Every live situation a stream query matches now, as the egress serves them, up to a cap. */
  async function liveSituations(q: StreamQuery): Promise<Rec[]> {
    const at = new Date();
    const out: Rec[] = [];
    let cursor: string | null = null;
    do {
      const read: Awaited<ReturnType<typeof listSituations>> = await listSituations(db, {
        at,
        limit: STREAM_PAGE,
        ...filtersOf(q),
        ...(cursor !== null ? { cursor } : {}),
      });
      out.push(
        ...(permissiveRecords(read.records as unknown as EgressRecord[]) as unknown as Rec[]),
      );
      cursor = read.next;
    } while (cursor !== null && out.length < STREAM_MAX);
    return out.slice(0, STREAM_MAX);
  }

  const streams = new Set<() => void>();
  const maxStreams = deps.streamMaxConnections ?? streamMaxConnectionsFromEnv();
  app.addHook("preClose", async () => {
    for (const stop of streams) stop();
  });

  app.get("/situations", async (req, reply) => {
    const q = parse(SituationListQuery, req.query, reply);
    if (!q) return reply;
    const { at, records, next } = await page(q);
    cacheFor(reply, records, at);
    reply.header("X-Data-License", licensesOf(records));
    return reply.send({ records, next });
  });

  app.get("/situations.geojson", async (req, reply) => {
    const q = parse(SituationListQuery, req.query, reply);
    if (!q) return reply;
    const { at, records, next } = await page(q);
    cacheFor(reply, records, at);
    reply.header("Content-Type", "application/geo+json");
    reply.header("X-Data-License", licensesOf(records));
    const info = { ...FEED_INFO, timestamp: new Date().toISOString() };
    return reply.send(situationsToGeoJSON(records, info, { at, next }));
  });

  app.get("/situations.jsonld", async (req, reply) => {
    const q = parse(SituationListQuery, req.query, reply);
    if (!q) return reply;
    const { at, records, next } = await page(q);
    cacheFor(reply, records, at);
    reply.header("Content-Type", "application/ld+json");
    reply.header("X-Data-License", licensesOf(records));
    const info = { ...FEED_INFO, timestamp: new Date().toISOString() };
    return reply.send(situationsToJsonLd(records, info, { at, next }));
  });

  app.get("/traff.xml", async (req, reply) => {
    const q = parse(SituationListQuery, req.query, reply);
    if (!q) return reply;
    const { at, records, next } = await page(q);
    cacheFor(reply, records, at);
    linkNext(reply, req.url, next);
    reply.header("Content-Type", "application/xml; charset=utf-8");
    reply.header("X-Data-License", licensesOf(records));
    return reply.send(situationsToTraff(deps.registry, records, at));
  });

  app.get("/datex2/situations.xml", async (req, reply) => {
    const q = parse(SituationListQuery, req.query, reply);
    if (!q) return reply;
    const { at, records, next } = await page(q);
    cacheFor(reply, records, at);
    linkNext(reply, req.url, next);
    reply.header("Content-Type", "application/xml; charset=utf-8");
    reply.header("X-Data-License", licensesOf(records));
    const info = { ...FEED_INFO, timestamp: new Date().toISOString() };
    return reply.send(situationsToDatex(records, at, info));
  });

  app.get("/stream", (req, reply) => {
    const q = parse(StreamQuery, req.query, reply);
    if (!q) return reply;
    // Each connection re-reads its situations every poll; past the cap a
    // client waits rather than every stream slowing the database.
    if (streams.size >= maxStreams) {
      reply.header("Retry-After", "30");
      return reply.status(503).send({ error: "too many live streams" });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // Later ticks may add sources, so no licence list up front; every
      // record sent passes the same egress as the collections.
      "X-Data-License": "permissive (share-alike withheld)",
    });
    const stop = startRecordStream({
      output: reply.raw,
      read: () => liveSituations(q),
      ...(deps.streamPollMs !== undefined ? { pollMs: deps.streamPollMs } : {}),
      onError: (err) => req.log.error(err, "[stream] poll failed"),
      onStop: () => streams.delete(stop),
    });
    streams.add(stop);
    return reply;
  });

  app.get("/situations/:id", async (req, reply) => {
    const q = parse(AtQuery, req.query, reply);
    if (!q) return reply;
    const { id } = req.params as { id: string };
    const record = await readRecord(sql, "situation", id);
    if (record === undefined || !isPermissiveRecord(record as unknown as EgressRecord)) {
      return reply.status(404).send({ error: "no such situation" });
    }
    const [egress] = permissiveRecords([record as unknown as EgressRecord]) as unknown as Rec[];
    const [binding] = await sql<
      { status: string; confidence: number | null; direction_mode: string; bound_at: Date }[]
    >`
      SELECT status, confidence, direction_mode, bound_at FROM conditions.record_binding
       WHERE record_class = 'situation' AND record_id = ${id} AND effect_id = ''`;
    const at = q.at ? new Date(q.at) : new Date();
    cacheFor(reply, [egress!], at);
    reply.header("X-Data-License", licensesOf([egress!]));
    return reply.send({
      record: egress,
      binding: binding
        ? {
            status: binding.status,
            confidence: binding.confidence,
            directionMode: binding.direction_mode,
            boundAt: binding.bound_at.toISOString(),
          }
        : null,
    });
  });

  app.get("/history/:class/:id", async (req, reply) => {
    const { class: raw, id } = req.params as { class: string; id: string };
    const cls = parse(RecordClassParam, raw, reply);
    if (!cls) return reply;
    const revisions = await readRevisions(sql, cls, id);
    const permissive = revisions.filter((r) =>
      isPermissiveRecord(r.record as unknown as EgressRecord),
    );
    if (permissive.length === 0) return reply.status(404).send({ error: "no such record" });
    reply.header("Cache-Control", `public, max-age=${MAX_CACHE_SECONDS}`);
    return reply.send({
      class: cls,
      id,
      revisions: permissive.map((r) => ({
        ...r,
        record: permissiveRecords([r.record as unknown as EgressRecord])[0],
      })),
    });
  });

  app.get("/taxonomy", async (_req, reply) => {
    taxonomy ??= taxonomyOf(deps.registry);
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send(taxonomy);
  });

  app.get("/schemas/*", async (req, reply) => {
    artifacts ??= jsonSchemaArtifacts(deps.registry);
    const path = (req.params as { "*": string })["*"];
    const schema = artifacts.get(path);
    if (schema === undefined) return reply.status(404).send({ error: "no such schema" });
    reply.header("Content-Type", "application/schema+json");
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send(schema);
  });

  app.get("/coverage", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return reply.send({ generatedAt: new Date().toISOString(), coverage: await readCoverage(db) });
  });

  app.get("/openapi.json", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send(openApiDocument());
  });
}
