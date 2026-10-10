import {
  canonicalFeatureRecord,
  dedupeSituations,
  type ExpandedFeature,
  latestOfFeatures,
  listCanonicalFeatures,
  listFeatures,
  listLatestObservations,
  listOffers,
  listSituations,
  offersOfFeatures,
  type QueryRunner,
  readCoverage,
  readGrid,
  readSeries,
  type Scope,
  withoutComponents,
} from "@openconditions/core";
import {
  type CanonicalFeature,
  readCanonical,
  readRecord,
  readRevisions,
} from "@openconditions/core/server";
import {
  type Catalog,
  type EgressRecord,
  type Env,
  type ImpersonationOptions,
  isPublicRecord,
  type LookupFn,
  publicRecords,
  withoutReporter,
} from "@openconditions/ingest-framework";
import { jsonSchemaArtifacts, parseRecordId, type Registry } from "@openconditions/model";
import {
  type FeedInfo,
  featuresToGeoJSON,
  featuresToJsonLd,
  nextEffectTransition,
  situationsToDatex,
  situationsToGeoJSON,
  situationsToJsonLd,
  situationsToTraff,
} from "@openconditions/publishers";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import type { z } from "zod";
import {
  type OnDemandCoverage,
  type ReadThroughQuery,
  readThrough,
} from "../on-demand/read-through.js";
import { startRecordStream } from "../record-stream.js";
import type { InFlight } from "../shutdown.js";
import { openApiDocument } from "./openapi.js";
import {
  AtQuery,
  FeatureListQuery,
  FeatureQuery,
  GridQuery,
  LatestObservationQuery,
  OfferListQuery,
  queryError,
  RecordClassParam,
  SeriesQuery,
  SituationListQuery,
  StreamQuery,
  windowIssue,
} from "./query.js";
import { scopeOf } from "./scope.js";
import { sourcesOf } from "./sources.js";
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
    ...(q.excludeKind ? { excludeKinds: q.excludeKind } : {}),
    ...(q.type ? { types: q.type } : {}),
    ...(q.domain ? { domain: q.domain } : {}),
    ...(q.source ? { sources: q.source } : {}),
    ...(q.origin ? { origins: q.origin } : {}),
    ...(q.minSeverity ? { minSeverity: q.minSeverity } : {}),
  };
}

/** Readings change every poll: a collection or series is cached this long. */
const OBSERVATION_CACHE_SECONDS = 30;

/** A grid of readings changes with polls an hour apart and is costly to build. */
const GRID_CACHE_SECONDS = 60;

/** Features and offers change with their source's poll. */
function cacheRecords(reply: FastifyReply): void {
  reply.header("Cache-Control", `public, max-age=${MAX_CACHE_SECONDS}`);
}

/**
 * Records as the egress serves them in `scope`: in the public scope records
 * whose licence is not public are withheld; in every scope a crowd
 * reporter's key is stripped. A restricted source's records are withheld
 * by the reader, or by `servable` for a single record.
 */
function egress(records: readonly Rec[], scope: Scope): Rec[] {
  const egressRecords = records as unknown as EgressRecord[];
  return (scope === "operator"
    ? egressRecords.map(withoutReporter)
    : publicRecords(egressRecords)) as unknown as Rec[];
}

/**
 * A cluster's canonical feature as the egress serves it, and the members it
 * is built from: the ones it may serve only, so a withheld member lends it
 * neither components, credit, readings nor offers. Undefined when every
 * member is withheld.
 */
function canonicalEgress(
  cluster: CanonicalFeature,
  members: readonly Rec[],
  scope: Scope,
): { record: Rec; feature: ExpandedFeature } | undefined {
  const served = egress(members, scope);
  const [record] = egress(
    [canonicalFeatureRecord(cluster, served)].filter((r) => r !== undefined),
    scope,
  );
  return record === undefined
    ? undefined
    : {
        record,
        feature: {
          id: record["id"] as string,
          memberIds: served.map((m) => m["id"] as string),
          components: cluster.components,
        },
      };
}

/** How the JSON collections read on-demand sources through; without it they read storage only. */
export interface OnDemandReads {
  /** The catalogue whose on-demand feeds a bbox read may fetch. */
  catalog: Pick<Catalog, "feeds">;
  /** undici's fetch in production: the egress guard pins its sockets. */
  fetch: typeof fetch;
  /** How long a read waits for its fetches (`OPENCONDITIONS_ON_DEMAND_DEADLINE_MS`). */
  deadlineMs: number;
  /** The instance on-demand records are written as. */
  instanceId: string;
  /** Where credentials are read; defaults to `process.env`. */
  env?: Env;
  /** Overrides the DNS resolver of the egress guard; tests only. */
  lookup?: LookupFn;
  /** Replaces the impersonating client of an `impersonate` endpoint; tests only. */
  impersonation?: ImpersonationOptions;
  /** Tracks each cell fetch, so shutdown waits for one a read left running. */
  inFlight?: Pick<InFlight, "track">;
}

/**
 * The response headers and body fields a read-through adds: a partial answer
 * is not cached, since the missing cells may land within seconds.
 */
function withCoverage(reply: FastifyReply, coverage: OnDemandCoverage | undefined) {
  if (coverage === undefined) return {};
  if (coverage.partial) reply.header("Cache-Control", "no-store");
  return { coverage };
}

/** What a feature read expands, from its `expand` list. */
const expansionsOf = (expand: readonly string[] | undefined) => new Set(expand ?? []);

const sourceIdOf = (record: Rec) => (record["provenance"] as Rec)["sourceId"] as string;

/**
 * Whether a stored record is current at `at` by the listings' rule: its
 * expiry, when it has one, has not passed. A record past it is not served
 * even before the sweep removes it.
 */
function currentAt(record: Rec, at: Date): boolean {
  const expiresAt = (record["freshness"] as Rec | undefined)?.["expiresAt"];
  return typeof expiresAt !== "string" || Date.parse(expiresAt) > at.getTime();
}

/** The first position of a record's geometry, `[lon, lat]`; undefined without one. */
function pointOf(record: Rec): [number, number] | undefined {
  const geometry = (record["location"] as Rec | undefined)?.["geometry"] as Rec | undefined;
  let coordinates: unknown = geometry?.["coordinates"];
  while (Array.isArray(coordinates) && Array.isArray(coordinates[0])) coordinates = coordinates[0];
  if (!Array.isArray(coordinates)) return undefined;
  const [lon, lat] = coordinates as unknown[];
  return typeof lon === "number" && typeof lat === "number" ? [lon, lat] : undefined;
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
 * canonical cluster (features, listed or one, expanded on request with their
 * readings in effect and live offers), one offer, a record's history, the registry's taxonomy
 * and JSON Schemas, coverage and the OpenAPI document. Every record leaves
 * through the request's scope (`registerScope`): the public scope withholds
 * a restricted source's records and records whose licence is not public (a
 * canonical feature is built from its served members only), the operator
 * scope withholds nothing. The emitters (`/situations.geojson`,
 * `/situations.jsonld`, `/traff.xml`, `/datex2/situations.xml`, `/stream`,
 * `/features.geojson`, `/features.jsonld`) always read in the public scope.
 * A crowd reporter's key is stripped in every scope. With `onDemand`, a
 * `/features`, `/observations/latest` or `/offers` read with a bbox first
 * fetches the stale cells of the on-demand sources it touches (`readThrough`)
 * and reports their `coverage`; the GeoJSON and JSON-LD variants never fetch.
 * A single situation, feature or offer past its expiry is not served, as the
 * collections do not list it; a `/features/{id}` read whose on-demand record
 * (or member) expired fetches that record's cell from its own source again
 * first, and answers 404 only when the record is still not current.
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
    /** Absent, no read fetches on-demand sources. */
    onDemand?: OnDemandReads;
    /** The catalogue `/sources` lists; absent, the list is empty. */
    catalog?: Pick<Catalog, "sources">;
  },
): void {
  const db: QueryRunner = {
    execute: async <T>(query: string, params?: unknown[]) =>
      (await sql.unsafe(query, params as never)) as T,
  };
  const now = deps.now ?? (() => new Date());
  let artifacts: Map<string, unknown> | undefined;
  let taxonomy: ReturnType<typeof taxonomyOf> | undefined;

  /**
   * Fetches the stale cells of the on-demand sources a bbox read touches
   * before it reads storage; undefined when the read has no bbox or no
   * on-demand source applies. Never fails the read: a fault of the
   * read-through itself is logged and the read answers from storage.
   */
  async function readOnDemand(
    req: FastifyRequest,
    q: Partial<Omit<ReadThroughQuery, "scope" | "class">> & Pick<ReadThroughQuery, "class">,
  ): Promise<OnDemandCoverage | undefined> {
    const reads = deps.onDemand;
    if (reads === undefined || q.bbox === undefined) return undefined;
    try {
      return await readThrough(
        sql,
        reads.catalog,
        {
          bbox: q.bbox,
          class: q.class,
          scope: scopeOf(req),
          ...(q.kinds ? { kinds: q.kinds } : {}),
          ...(q.properties ? { properties: q.properties } : {}),
          ...(q.domain ? { domain: q.domain } : {}),
          ...(q.sources ? { sources: q.sources } : {}),
          ...(q.at ? { at: q.at } : {}),
        },
        {
          fetch: reads.fetch,
          now,
          deadlineMs: reads.deadlineMs,
          registry: deps.registry,
          instanceId: reads.instanceId,
          ...(reads.env ? { env: reads.env } : {}),
          ...(reads.lookup ? { lookup: reads.lookup } : {}),
          ...(reads.impersonation ? { impersonation: reads.impersonation } : {}),
          ...(reads.inFlight ? { inFlight: reads.inFlight } : {}),
        },
      );
    } catch (err) {
      req.log.error(err, "[on-demand] read-through failed");
      return undefined;
    }
  }

  /**
   * The ids of `sourceIds` the catalogue marks restricted. Read from
   * `conditions.source`, so an inactive source keeps its mark and a peer's
   * or the crowd's source, which it does not hold, is not restricted.
   */
  async function restrictedOf(sourceIds: readonly string[]): Promise<Set<string>> {
    const distinct = [...new Set(sourceIds)];
    if (distinct.length === 0) return new Set();
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM conditions.source WHERE id = ANY(${distinct}::text[]) AND restricted`;
    return new Set(rows.map((r) => r.id));
  }

  /**
   * The single records `scope` may see, before the licence egress: in the
   * public scope none of a restricted source, as the list readers withhold
   * them; in the operator scope all of them.
   */
  async function servable(records: readonly Rec[], scope: Scope): Promise<Rec[]> {
    if (scope === "operator" || records.length === 0) return [...records];
    const restricted = await restrictedOf(records.map(sourceIdOf));
    return records.filter((r) => !restricted.has(sourceIdOf(r)));
  }

  /** The ids of `featureIds` whose source is restricted. */
  async function restrictedFeatures(featureIds: readonly string[]): Promise<Set<string>> {
    if (featureIds.length === 0) return new Set();
    const rows = await sql<{ id: string }[]>`
      SELECT f.id FROM conditions.feature f
        JOIN conditions.source s ON s.id = f.source_id
       WHERE f.id = ANY(${[...featureIds]}::text[]) AND s.restricted`;
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Parses a situation collection query, answering 400 for a time window
   * that, ending now, starts after now or spans too long.
   */
  function parseSituations(req: FastifyRequest, reply: FastifyReply) {
    const q = parse(SituationListQuery, req.query, reply);
    if (!q || q.from === undefined || q.to !== undefined) return q;
    const issue = windowIssue(new Date(q.from), now());
    if (issue === undefined) return q;
    void reply
      .status(400)
      .send({ error: "invalid query", issues: [{ path: "from", message: issue }] });
    return undefined;
  }

  /** One page of situations as the egress serves them in `scope`, and the instant they were read at. */
  async function page(q: z.output<typeof SituationListQuery>, scope: Scope) {
    const at = q.at ? new Date(q.at) : now();
    const read = await listSituations(db, {
      scope,
      at,
      limit: q.limit,
      ...filtersOf(q),
      ...(q.subtype ? { subtypes: q.subtype } : {}),
      ...(q.horizonDays !== undefined ? { horizonDays: q.horizonDays } : {}),
      ...(q.from ? { from: new Date(q.from), to: q.to ? new Date(q.to) : at } : {}),
      ...(q.simplify !== undefined ? { simplify: q.simplify } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    const shown = egress(read.records, scope);
    const records = q.dedupe === "1" ? dedupeSituations(shown) : shown;
    return { at, records, next: read.next };
  }

  /** Every live situation a stream query matches now, as the public egress serves them, up to a cap. */
  async function liveSituations(q: StreamQuery): Promise<Rec[]> {
    const at = new Date();
    const out: Rec[] = [];
    let cursor: string | null = null;
    do {
      const read: Awaited<ReturnType<typeof listSituations>> = await listSituations(db, {
        scope: "public",
        at,
        limit: STREAM_PAGE,
        ...filtersOf(q),
        ...(cursor !== null ? { cursor } : {}),
      });
      out.push(...egress(read.records, "public"));
      cursor = read.next;
    } while (cursor !== null && out.length < STREAM_MAX);
    return out.slice(0, STREAM_MAX);
  }

  const streams = new Set<() => void>();
  const maxStreams = deps.streamMaxConnections ?? streamMaxConnectionsFromEnv();
  app.addHook("preClose", async () => {
    for (const stop of streams) stop();
  });

  // The emitters (GeoJSON, JSON-LD, TraFF, DATEX II, the stream) are public
  // feeds: they read in the public scope whoever asks.
  app.get("/situations", async (req, reply) => {
    const q = parseSituations(req, reply);
    if (!q) return reply;
    const { at, records, next } = await page(q, scopeOf(req));
    cacheFor(reply, records, at);
    reply.header("X-Data-License", licensesOf(records));
    return reply.send({ records, next });
  });

  app.get("/situations.geojson", async (req, reply) => {
    const q = parseSituations(req, reply);
    if (!q) return reply;
    const { at, records, next } = await page(q, "public");
    cacheFor(reply, records, at);
    reply.header("Content-Type", "application/geo+json");
    reply.header("X-Data-License", licensesOf(records));
    const info = { ...FEED_INFO, timestamp: new Date().toISOString() };
    return reply.send(situationsToGeoJSON(records, info, { at, next }));
  });

  app.get("/situations.jsonld", async (req, reply) => {
    const q = parseSituations(req, reply);
    if (!q) return reply;
    const { at, records, next } = await page(q, "public");
    cacheFor(reply, records, at);
    reply.header("Content-Type", "application/ld+json");
    reply.header("X-Data-License", licensesOf(records));
    const info = { ...FEED_INFO, timestamp: new Date().toISOString() };
    return reply.send(situationsToJsonLd(records, info, { at, next }));
  });

  app.get("/traff.xml", async (req, reply) => {
    const q = parseSituations(req, reply);
    if (!q) return reply;
    const { at, records, next } = await page(q, "public");
    cacheFor(reply, records, at);
    linkNext(reply, req.url, next);
    reply.header("Content-Type", "application/xml; charset=utf-8");
    reply.header("X-Data-License", licensesOf(records));
    return reply.send(situationsToTraff(deps.registry, records, at));
  });

  app.get("/datex2/situations.xml", async (req, reply) => {
    const q = parseSituations(req, reply);
    if (!q) return reply;
    const { at, records, next } = await page(q, "public");
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
      "X-Data-License": "public (restricted sources and licences withheld)",
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
    const scope = scopeOf(req);
    const at = q.at ? new Date(q.at) : now();
    const stored = await readRecord(sql, "situation", id);
    const live = stored !== undefined && currentAt(stored, at) ? [stored] : [];
    const [record] = egress(await servable(live, scope), scope);
    if (record === undefined) return reply.status(404).send({ error: "no such situation" });
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
    cacheFor(reply, [record], at);
    reply.header("X-Data-License", licensesOf([record]));
    return reply.send({
      record,
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
    const scope = scopeOf(req);
    const stored = await readRevisions(sql, cls, id);
    const restricted =
      scope === "operator"
        ? new Set<string>()
        : await restrictedOf(stored.map((r) => sourceIdOf(r.record)));
    const revisions = stored.flatMap((r) => {
      if (restricted.has(sourceIdOf(r.record))) return [];
      const [record] = egress([r.record], scope);
      return record === undefined ? [] : [{ ...r, record }];
    });
    if (revisions.length === 0) return reply.status(404).send({ error: "no such record" });
    reply.header("Cache-Control", `public, max-age=${MAX_CACHE_SECONDS}`);
    reply.header("X-Data-License", licensesOf(revisions.map((r) => r.record)));
    return reply.send({ class: cls, id, revisions });
  });

  /**
   * One page of features as the egress serves them in `scope`: per source,
   * or the canonical view (one feature per cluster, with the members it is
   * built from); components only when asked.
   */
  async function featurePage(q: FeatureListQuery, scope: Scope, at: Date) {
    const query = {
      scope,
      at,
      limit: q.limit,
      ...filtersOf(q),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    };
    let records: Rec[];
    let features: ExpandedFeature[];
    let next: string | null;
    if (q.canonical === "1") {
      const read = await listCanonicalFeatures(db, query);
      const shown = read.clusters.flatMap((c) => canonicalEgress(c, c.members, scope) ?? []);
      records = shown.map((s) => s.record);
      features = shown.map((s) => s.feature);
      next = read.next;
    } else {
      const read = await listFeatures(db, query);
      records = egress(read.records, scope);
      features = records.map((r) => ({ id: r["id"] as string }));
      next = read.next;
    }
    return {
      records: expansionsOf(q.expand).has("components") ? records : records.map(withoutComponents),
      features,
      next,
    };
  }

  /**
   * The readings in effect and the live offers of `features` that `expand`
   * asks for, as the egress serves them in `scope`, by feature id; and the
   * records they came from, for the licence header (a member's reading a
   * fused one stands in for included).
   */
  async function expansions(
    features: readonly ExpandedFeature[],
    opts: { canonical: boolean; expand: Set<string>; scope: Scope; at: Date },
  ) {
    const served: Rec[] = [];
    const shown = (records: readonly Rec[]) => {
      const out = egress(records, opts.scope);
      served.push(...out);
      return out;
    };
    const latest = opts.expand.has("latest")
      ? await latestOfFeatures(db, {
          registry: deps.registry,
          features,
          canonical: opts.canonical,
          scope: opts.scope,
          at: opts.at,
          egress: shown,
        })
      : undefined;
    let offers: Map<string, Rec[]> | undefined;
    if (opts.expand.has("offers")) {
      offers = await offersOfFeatures(db, { features, scope: opts.scope, at: opts.at });
      for (const [id, records] of offers) offers.set(id, shown(records));
    }
    return { latest, offers, served };
  }

  /** Readings change every poll; features and offers with their source's. */
  function cacheExpanded(reply: FastifyReply, expand: Set<string>): void {
    if (expand.has("latest")) {
      reply.header("Cache-Control", `public, max-age=${OBSERVATION_CACHE_SECONDS}`);
    } else {
      cacheRecords(reply);
    }
  }

  app.get("/features", async (req, reply) => {
    const q = parse(FeatureListQuery, req.query, reply);
    if (!q) return reply;
    const scope = scopeOf(req);
    const coverage = await readOnDemand(req, {
      bbox: q.bbox,
      class: "feature",
      kinds: q.kind,
      domain: q.domain,
      sources: q.source,
      at: q.at ? new Date(q.at) : undefined,
    });
    const at = q.at ? new Date(q.at) : now();
    const expand = expansionsOf(q.expand);
    const { records, features, next } = await featurePage(q, scope, at);
    const { latest, offers, served } = await expansions(features, {
      canonical: q.canonical === "1",
      expand,
      scope,
      at,
    });
    cacheExpanded(reply, expand);
    reply.header("X-Data-License", licensesOf([...records, ...served]));
    return reply.send({
      records,
      ...(latest ? { latest: Object.fromEntries(latest) } : {}),
      ...(offers ? { offers: Object.fromEntries(offers) } : {}),
      next,
      ...withCoverage(reply, coverage),
    });
  });

  app.get("/features.geojson", async (req, reply) => {
    const q = parse(FeatureListQuery, req.query, reply);
    if (!q) return reply;
    const { records, next } = await featurePage(q, "public", q.at ? new Date(q.at) : now());
    cacheRecords(reply);
    reply.header("Content-Type", "application/geo+json");
    reply.header("X-Data-License", licensesOf(records));
    const info = { ...FEED_INFO, timestamp: now().toISOString() };
    return reply.send(featuresToGeoJSON(records, info, { next }));
  });

  app.get("/features.jsonld", async (req, reply) => {
    const q = parse(FeatureListQuery, req.query, reply);
    if (!q) return reply;
    const { records, next } = await featurePage(q, "public", q.at ? new Date(q.at) : now());
    cacheRecords(reply);
    reply.header("Content-Type", "application/ld+json");
    reply.header("X-Data-License", licensesOf(records));
    const info = { ...FEED_INFO, timestamp: now().toISOString() };
    return reply.send(featuresToJsonLd(records, info, { next }));
  });

  app.get("/features/:id", async (req, reply) => {
    const q = parse(FeatureQuery, req.query, reply);
    if (!q) return reply;
    const { id } = req.params as { id: string };
    const scope = scopeOf(req);
    const at = q.at ? new Date(q.at) : now();
    let read = await readFeature(id, scope, at);
    if (await refreshExpired(req, read.expired, q.at ? at : undefined)) {
      read = await readFeature(id, scope, at);
    }
    const { cluster, canonical, record, feature, memberIds } = read;
    if (record === undefined) return reply.status(404).send({ error: "no such feature" });
    const expand = expansionsOf(q.expand);
    const { latest, offers, served } = await expansions([feature], {
      canonical,
      expand,
      scope,
      at,
    });
    cacheExpanded(reply, expand);
    reply.header("X-Data-License", licensesOf([record, ...served]));
    return reply.send({
      record,
      ...(latest ? { latest: latest.get(id) ?? [] } : {}),
      ...(offers ? { offers: offers.get(id) ?? [] } : {}),
      canonical:
        cluster === undefined
          ? null
          : {
              canonicalFeatureId: cluster.canonicalFeatureId,
              survivorId: memberIds.includes(cluster.survivorId)
                ? cluster.survivorId
                : memberIds[0],
              memberIds,
            },
    });
  });

  /**
   * One feature by id as the egress serves it in `scope` at `at`: the
   * canonical feature built from its served members, or the source feature;
   * its cluster and the ids of the members served (current, not tombstoned,
   * not withheld by source or licence), in cluster order; and the on-demand
   * records it would have served had they not expired.
   */
  async function readFeature(id: string, scope: Scope, at: Date) {
    const cluster = await readCanonical(sql, id);
    // In the public scope a restricted source's member is not even read.
    const withheld =
      cluster === undefined || scope === "operator"
        ? new Set<string>()
        : await restrictedFeatures(cluster.memberIds);
    const visible = cluster?.memberIds.filter((m) => !withheld.has(m)) ?? [];
    const stored = (await Promise.all(visible.map((m) => readRecord(sql, "feature", m)))).filter(
      (m): m is Rec => m !== undefined && m["tombstone"] === undefined,
    );
    const live = stored.filter((m) => currentAt(m, at));
    const expired = stored.filter((m) => !currentAt(m, at));
    const memberIds = egress(live, scope).map((m) => m["id"] as string);
    const canonical = cluster !== undefined && cluster.canonicalFeatureId === id;
    let record: Rec | undefined;
    let feature: ExpandedFeature = { id };
    if (canonical) {
      const shown = canonicalEgress(cluster, live, scope);
      record = shown?.record;
      if (shown) feature = shown.feature;
    } else {
      const own = await readRecord(sql, "feature", id);
      if (own !== undefined && !currentAt(own, at)) {
        if (!expired.some((m) => m["id"] === id)) expired.push(own);
      } else {
        [record] = egress(await servable(own === undefined ? [] : [own], scope), scope);
      }
    }
    return { cluster, canonical, record, feature, memberIds, expired };
  }

  /**
   * Fetches again the cell of each expired on-demand record a single read
   * would serve, from the record's own source only, before the read is
   * answered: the sweep has not removed it yet, and its source may still
   * list it. The read-through's scope, limits and deadline apply, and a read
   * of a past instant (`at`) fetches nothing. True when any source took
   * part, so the read is made again.
   */
  async function refreshExpired(
    req: FastifyRequest,
    expired: readonly Rec[],
    at: Date | undefined,
  ): Promise<boolean> {
    const reads = expired.flatMap((record) => {
      if ((record["provenance"] as Rec)["accessMode"] !== "on_demand") return [];
      const point = pointOf(record);
      if (point === undefined) return [];
      const [lon, lat] = point;
      return [
        readOnDemand(req, {
          bbox: [lon, lat, lon, lat],
          class: "feature",
          kinds: [record["kind"] as string],
          sources: [sourceIdOf(record)],
          at,
        }),
      ];
    });
    if (reads.length === 0) return false;
    const coverages = await Promise.all(reads);
    return coverages.some((c) => c !== undefined);
  }

  app.get("/offers", async (req, reply) => {
    const q = parse(OfferListQuery, req.query, reply);
    if (!q) return reply;
    const scope = scopeOf(req);
    const coverage = await readOnDemand(req, {
      bbox: q.bbox,
      class: "offer",
      kinds: q.kind,
      domain: q.domain,
      sources: q.source,
      at: q.at ? new Date(q.at) : undefined,
    });
    const read = await listOffers(db, {
      scope,
      at: q.at ? new Date(q.at) : now(),
      limit: q.limit,
      ...filtersOf(q),
      ...(q.horizonDays !== undefined ? { horizonDays: q.horizonDays } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    const records = egress(read.records, scope);
    cacheRecords(reply);
    reply.header("X-Data-License", licensesOf(records));
    return reply.send({ records, next: read.next, ...withCoverage(reply, coverage) });
  });

  app.get("/offers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = scopeOf(req);
    const stored = await readRecord(sql, "offer", id);
    const live = stored !== undefined && currentAt(stored, now()) ? [stored] : [];
    const [record] = egress(await servable(live, scope), scope);
    if (record === undefined) return reply.status(404).send({ error: "no such offer" });
    cacheRecords(reply);
    reply.header("X-Data-License", licensesOf([record]));
    return reply.send({ record });
  });

  app.get("/observations/latest", async (req, reply) => {
    const q = parse(LatestObservationQuery, req.query, reply);
    if (!q) return reply;
    const scope = scopeOf(req);
    const coverage = await readOnDemand(req, {
      bbox: q.bbox,
      class: "observation",
      properties: q.property,
      domain: q.domain,
      sources: q.source,
      at: q.at ? new Date(q.at) : undefined,
    });
    const read = await listLatestObservations(db, deps.registry, {
      scope,
      at: q.at ? new Date(q.at) : now(),
      limit: q.limit,
      canonical: q.canonical === "1",
      ...(q.bbox ? { bbox: q.bbox } : {}),
      ...(q.property ? { properties: q.property } : {}),
      ...(q.domain ? { domain: q.domain } : {}),
      ...(q.source ? { sources: q.source } : {}),
      ...(q.origin ? { origins: q.origin } : {}),
      ...(q.since ? { since: new Date(q.since) } : {}),
      ...(q.cursor ? { cursor: Number(q.cursor) } : {}),
    });
    const records = egress(read.records, scope);
    reply.header("Cache-Control", `public, max-age=${OBSERVATION_CACHE_SECONDS}`);
    reply.header("X-Data-License", licensesOf(records));
    return reply.send({ records, next: read.next, ...withCoverage(reply, coverage) });
  });

  // Cells stand for readings a map cannot draw one by one at a low zoom;
  // they pass the scope and the licence egress the readings would.
  app.get("/observations/grid", async (req, reply) => {
    const q = parse(GridQuery, req.query, reply);
    if (!q) return reply;
    const scope = scopeOf(req);
    const licenses = new Set<string>();
    const grid = await readGrid(db, {
      scope,
      property: q.property,
      bbox: q.bbox,
      cellDeg: q.cellDeg,
      since: new Date(q.since),
      at: now(),
      ...(q.source ? { sources: q.source } : {}),
      admits: (provenance) => {
        const shown =
          scope === "operator" || isPublicRecord({ provenance } as unknown as EgressRecord);
        if (shown) licenses.add(provenance.attribution.license);
        return shown;
      },
    });
    reply.header("Cache-Control", `public, max-age=${GRID_CACHE_SECONDS}`);
    reply.header("X-Data-License", licenses.size > 0 ? [...licenses].sort().join(", ") : "none");
    return reply.send(grid);
  });

  app.get("/observations", async (req, reply) => {
    const q = parse(SeriesQuery, req.query, reply);
    if (!q) return reply;
    const scope = scopeOf(req);
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
        scope,
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
    // The reader withholds a restricted source's series from the public;
    // the licence gate is the egress's.
    const egressSeries =
      read.status === "found" &&
      (scope === "operator" ||
        isPublicRecord({ provenance: read.series.provenance } as unknown as EgressRecord));
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
      ...(read.records !== undefined ? { records: egress(read.records, scope) } : {}),
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

  app.get("/coverage", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    const at = now();
    const coverage = await readCoverage(db, { scope: scopeOf(req), at });
    return reply.send({ generatedAt: at.toISOString(), coverage });
  });

  // The list is the same in every scope; `scope` tells a consumer whether
  // the restricted sources it names are served to it.
  app.get("/sources", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return reply.send({
      generatedAt: now().toISOString(),
      scope: scopeOf(req),
      sources: deps.catalog ? sourcesOf(deps.catalog) : [],
    });
  });

  app.get("/openapi.json", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send(openApiDocument());
  });
}
