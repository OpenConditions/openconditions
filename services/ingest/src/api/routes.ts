import {
  canonicalFeatureRecord,
  dedupeSituations,
  listCanonicalFeatures,
  listFeatures,
  listLatestObservations,
  listOffers,
  listSituations,
  type QueryRunner,
  readCoverage,
  readSeries,
  withoutComponents,
} from "@openconditions/core";
import {
  type CanonicalFeature,
  readCanonical,
  readRecord,
  readRevisions,
} from "@openconditions/core/server";
import { jsonSchemaArtifacts, parseRecordId, type Registry } from "@openconditions/model";
import {
  type EgressRecord,
  type FeedInfo,
  featuresToGeoJSON,
  featuresToJsonLd,
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
import {
  AtQuery,
  FeatureListQuery,
  LatestObservationQuery,
  OfferListQuery,
  queryError,
  RecordClassParam,
  SeriesQuery,
  SituationListQuery,
  StreamQuery,
} from "./query.js";
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
function filtersOf(q: Omit<StreamQuery, "class" | "minSeverity"> & Partial<StreamQuery>) {
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

/** Readings change every poll: a collection or series is cached this long. */
const OBSERVATION_CACHE_SECONDS = 30;

/** Features and offers change with their source's poll. */
function cacheRecords(reply: FastifyReply): void {
  reply.header("Cache-Control", `public, max-age=${MAX_CACHE_SECONDS}`);
}

/** Records as the egress serves them: share-alike withheld, reporters stripped. */
const egress = (records: readonly Rec[]) =>
  permissiveRecords(records as unknown as EgressRecord[]) as unknown as Rec[];

/**
 * A cluster's canonical feature as the egress serves it: built from its
 * permissive members only, so a share-alike member lends it neither
 * components nor credit. Undefined when every member is withheld.
 */
function canonicalEgress(cluster: CanonicalFeature, members: readonly Rec[]): Rec | undefined {
  const record = canonicalFeatureRecord(cluster, egress(members));
  return record === undefined ? undefined : egress([record])[0];
}

/**
 * The subject key a series query names: a subject key as given, or a record
 * id (`oc:feature:…`) as its subject key, with the component appended.
 */
function subjectKeyOf(subject: string, component: string | undefined): string {
  const parts = parseRecordId(subject);
  const key = parts === null ? subject : `${parts.class}:${subject}`;
  return component === undefined ? key : `${key}#${component}`;
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
 * The record API: situation, feature and offer collections (JSON; GeoJSON
 * and JSON-LD for situations and features) paginated by a keyset cursor on
 * id, the latest readings paginated by series, one series' readings or
 * rollups, one situation with its evidence and binding, one feature with its
 * canonical cluster, one offer, a record's history, the registry's taxonomy
 * and JSON Schemas, coverage and the OpenAPI document. Every record leaves
 * through the licence egress: share-alike records are withheld (a canonical
 * feature is built from its permissive members only) and a crowd reporter's
 * key is stripped.
 */
export function registerApiRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  deps: {
    registry: Registry;
    streamPollMs?: number;
    streamMaxConnections?: number;
    /** The clock an absent `at` and the series retention read; default the system clock. */
    now?: () => Date;
  },
): void {
  const db: QueryRunner = {
    execute: async <T>(query: string, params?: unknown[]) =>
      (await sql.unsafe(query, params as never)) as T,
  };
  const now = deps.now ?? (() => new Date());
  let artifacts: Map<string, unknown> | undefined;
  let taxonomy: ReturnType<typeof taxonomyOf> | undefined;

  /** One page of situations as the egress serves them, and the instant they were read at. */
  async function page(q: z.output<typeof SituationListQuery>) {
    const at = q.at ? new Date(q.at) : now();
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
    // The situation's place binds as effect '', and each effect with a place
    // of its own binds on its own: that binding is the one routing reads.
    const bindings = await sql<
      {
        effect_id: string;
        status: string;
        confidence: number | null;
        direction_mode: string;
        bound_at: Date;
      }[]
    >`
      SELECT effect_id, status, confidence, direction_mode, bound_at
        FROM conditions.record_binding
       WHERE record_class = 'situation' AND record_id = ${id}
       ORDER BY effect_id`;
    const shown = (b: (typeof bindings)[number]) => ({
      status: b.status,
      confidence: b.confidence,
      directionMode: b.direction_mode,
      boundAt: b.bound_at.toISOString(),
    });
    const situationBinding = bindings.find((b) => b.effect_id === "");
    const at = q.at ? new Date(q.at) : new Date();
    cacheFor(reply, [egress!], at);
    reply.header("X-Data-License", licensesOf([egress!]));
    return reply.send({
      record: egress,
      binding: situationBinding ? shown(situationBinding) : null,
      effectBindings: Object.fromEntries(
        bindings.filter((b) => b.effect_id !== "").map((b) => [b.effect_id, shown(b)]),
      ),
    });
  });

  app.get("/history/:class/:id", async (req, reply) => {
    const { class: raw, id } = req.params as { class: string; id: string };
    const cls = parse(RecordClassParam, raw, reply);
    if (!cls) return reply;
    const stored = await readRevisions(sql, cls, id);
    const permissive = stored.filter((r) =>
      isPermissiveRecord(r.record as unknown as EgressRecord),
    );
    if (permissive.length === 0) return reply.status(404).send({ error: "no such record" });
    const revisions = permissive.map((r) => ({
      ...r,
      record: permissiveRecords([r.record as unknown as EgressRecord])[0] as unknown as Rec,
    }));
    reply.header("Cache-Control", `public, max-age=${MAX_CACHE_SECONDS}`);
    reply.header("X-Data-License", licensesOf(revisions.map((r) => r.record)));
    return reply.send({ class: cls, id, revisions });
  });

  /**
   * One page of features as the egress serves them: per source, or the
   * canonical view (one feature per cluster); components only when asked.
   */
  async function featurePage(q: FeatureListQuery) {
    const query = {
      at: q.at ? new Date(q.at) : now(),
      limit: q.limit,
      ...filtersOf(q),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    };
    let records: Rec[];
    let next: string | null;
    if (q.canonical === "1") {
      const read = await listCanonicalFeatures(db, query);
      records = read.clusters.flatMap((c) => {
        const record = canonicalEgress(c, c.members);
        return record === undefined ? [] : [record];
      });
      next = read.next;
    } else {
      const read = await listFeatures(db, query);
      records = egress(read.records);
      next = read.next;
    }
    return {
      records: q.expand === "components" ? records : records.map(withoutComponents),
      next,
    };
  }

  app.get("/features", async (req, reply) => {
    const q = parse(FeatureListQuery, req.query, reply);
    if (!q) return reply;
    const { records, next } = await featurePage(q);
    cacheRecords(reply);
    reply.header("X-Data-License", licensesOf(records));
    return reply.send({ records, next });
  });

  app.get("/features.geojson", async (req, reply) => {
    const q = parse(FeatureListQuery, req.query, reply);
    if (!q) return reply;
    const { records, next } = await featurePage(q);
    cacheRecords(reply);
    reply.header("Content-Type", "application/geo+json");
    reply.header("X-Data-License", licensesOf(records));
    const info = { ...FEED_INFO, timestamp: now().toISOString() };
    return reply.send(featuresToGeoJSON(records, info, { next }));
  });

  app.get("/features.jsonld", async (req, reply) => {
    const q = parse(FeatureListQuery, req.query, reply);
    if (!q) return reply;
    const { records, next } = await featurePage(q);
    cacheRecords(reply);
    reply.header("Content-Type", "application/ld+json");
    reply.header("X-Data-License", licensesOf(records));
    const info = { ...FEED_INFO, timestamp: now().toISOString() };
    return reply.send(featuresToJsonLd(records, info, { next }));
  });

  app.get("/features/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const cluster = await readCanonical(sql, id);
    let record: Rec | undefined;
    if (cluster !== undefined && cluster.canonicalFeatureId === id) {
      const members = await Promise.all(
        cluster.memberIds.map((m) => readRecord(sql, "feature", m)),
      );
      record = canonicalEgress(
        cluster,
        members.filter((m): m is Rec => m !== undefined && m["tombstone"] === undefined),
      );
    } else {
      const stored = await readRecord(sql, "feature", id);
      record = stored === undefined ? undefined : egress([stored])[0];
    }
    if (record === undefined) return reply.status(404).send({ error: "no such feature" });
    cacheRecords(reply);
    reply.header("X-Data-License", licensesOf([record]));
    return reply.send({
      record,
      canonical:
        cluster === undefined
          ? null
          : {
              canonicalFeatureId: cluster.canonicalFeatureId,
              survivorId: cluster.survivorId,
              memberIds: cluster.memberIds,
            },
    });
  });

  app.get("/offers", async (req, reply) => {
    const q = parse(OfferListQuery, req.query, reply);
    if (!q) return reply;
    const read = await listOffers(db, {
      at: q.at ? new Date(q.at) : now(),
      limit: q.limit,
      ...filtersOf(q),
      ...(q.horizonDays !== undefined ? { horizonDays: q.horizonDays } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    const records = egress(read.records);
    cacheRecords(reply);
    reply.header("X-Data-License", licensesOf(records));
    return reply.send({ records, next: read.next });
  });

  app.get("/offers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const stored = await readRecord(sql, "offer", id);
    const record = stored === undefined ? undefined : egress([stored])[0];
    if (record === undefined) return reply.status(404).send({ error: "no such offer" });
    cacheRecords(reply);
    reply.header("X-Data-License", licensesOf([record]));
    return reply.send({ record });
  });

  app.get("/observations/latest", async (req, reply) => {
    const q = parse(LatestObservationQuery, req.query, reply);
    if (!q) return reply;
    const read = await listLatestObservations(db, deps.registry, {
      at: q.at ? new Date(q.at) : now(),
      limit: q.limit,
      canonical: q.canonical === "1",
      ...(q.bbox ? { bbox: q.bbox } : {}),
      ...(q.property ? { properties: q.property } : {}),
      ...(q.domain ? { domain: q.domain } : {}),
      ...(q.source ? { sources: q.source } : {}),
      ...(q.origin ? { origins: q.origin } : {}),
      ...(q.cursor ? { cursor: Number(q.cursor) } : {}),
    });
    const records = egress(read.records);
    reply.header("Cache-Control", `public, max-age=${OBSERVATION_CACHE_SECONDS}`);
    reply.header("X-Data-License", licensesOf(records));
    return reply.send({ records, next: read.next });
  });

  app.get("/observations", async (req, reply) => {
    const q = parse(SeriesQuery, req.query, reply);
    if (!q) return reply;
    const clock = now();
    const to = q.to ? new Date(q.to) : clock;
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 86_400_000);
    if (from >= to)
      return reply.status(400).send({
        error: "invalid query",
        issues: [{ path: "from", message: "from must be before to" }],
      });
    const read = await readSeries(
      db,
      deps.registry,
      {
        subjectKey: subjectKeyOf(q.subject, q.component),
        property: q.property,
        ...(q.qualifiers ? { qualifiers: q.qualifiers } : {}),
        ...(q.source ? { sourceId: q.source } : {}),
      },
      {
        from,
        to,
        now: clock,
        limit: q.limit,
        ...(q.resolution ? { resolution: q.resolution } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      },
    );
    if (read.status === "ambiguous") {
      return reply.status(400).send({
        error: "several sources report this series; name one with `source`",
        sources: read.sources,
      });
    }
    if (read.status === "no_history") {
      return reply.status(400).send({
        error: `this ${read.property} series keeps no history; its reading in effect is at /observations/latest`,
      });
    }
    if (read.status === "no_rollup") {
      return reply.status(400).send({ error: `${read.property} keeps no ${q.resolution} rollup` });
    }
    const egressSeries =
      read.status === "found" &&
      isPermissiveRecord({ provenance: read.series.provenance } as unknown as EgressRecord);
    if (read.status === "none" || !egressSeries) {
      return reply.status(404).send({ error: "no such series" });
    }
    const { provenance: _provenance, ...series } = read.series;
    const license = (read.series.provenance["attribution"] as Rec)["license"] as string;
    reply.header("Cache-Control", `public, max-age=${OBSERVATION_CACHE_SECONDS}`);
    reply.header("X-Data-License", license);
    return reply.send({
      series,
      resolution: read.resolution,
      from: from.toISOString(),
      to: to.toISOString(),
      ...(read.records !== undefined ? { records: egress(read.records) } : {}),
      ...(read.rollups !== undefined ? { rollups: read.rollups } : {}),
      next: read.next,
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
    const at = now();
    return reply.send({ generatedAt: at.toISOString(), coverage: await readCoverage(db, { at }) });
  });

  app.get("/openapi.json", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send(openApiDocument());
  });
}
