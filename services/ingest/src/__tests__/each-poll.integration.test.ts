import { runMigrations } from "@openconditions/core/server";
import {
  type CatalogFeed,
  defineIngestDomain,
  emptyParseOutput,
  type FeedDefinition,
  type IngestDomain,
  type LookupFn,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { buildRegistry, extendVocabulary, type Registry } from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import { ensureObservationPartitions, retentionClasses } from "@openconditions/storage";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoleState, runSource } from "../pipeline/run.js";

const FORMAT = "station-details";

/** One fuel station per `detail` payload, a JSON `{ id, lon, lat }`. */
function parseDetails(feed: CatalogFeed, payloads: Readonly<Record<string, readonly Buffer[]>>) {
  const out = emptyParseOutput();
  for (const buffer of payloads["detail"] ?? []) {
    const s = JSON.parse(buffer.toString("utf8")) as { id: string; lon: number; lat: number };
    out.features.push({
      id: `oc:feature:${feed.id}:${s.id}`,
      class: "feature",
      kind: "fuel_station",
      temporality: "static",
      lifecycle: "operational",
      name: [{ lang: "de", text: `Station ${s.id}` }],
      location: {
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
      provenance: {
        origin: "feed",
        sourceId: feed.id,
        sourceFormat: FORMAT,
        accessMode: "bulk",
        recordId: s.id,
        attribution: { provider: "payload claim", license: "payload claim" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: "2026-10-03T10:00:00Z" },
      access: { audience: "public" },
      details: { kind: "fuel_station", v: 1, productsComplete: true },
    });
  }
  return out;
}

const testDomain: IngestDomain = defineIngestDomain({
  id: "fuel",
  products: ["fuel"],
  feedShape: {},
  formats: {
    [FORMAT]: {
      id: FORMAT,
      kind: "features",
      products: ["fuel"],
      endpoints: {
        sites: { required: false },
        detail: { required: true },
        status: { required: false },
      },
      parse: parseDetails,
    },
  },
  resolvers: [],
});

vi.mock("../domains.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../domains.js")>();
  const isTest = (feed: { domain: string }) => feed.domain === "fuel";
  return {
    ...original,
    domainOf: (feed: Parameters<typeof original.domainOf>[0]) =>
      isTest(feed) ? testDomain : original.domainOf(feed),
    formatOf: (feed: Parameters<typeof original.formatOf>[0]) =>
      isTest(feed) ? testDomain.formats[feed.format]! : original.formatOf(feed),
  };
});

const registry: Registry = buildRegistry([
  ...productionModules,
  {
    name: "station-details",
    entries: [extendVocabulary({ vocabulary: "source_format", values: [FORMAT] })],
  },
]);

const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date("2026-10-03T10:00:00Z"),
  });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/**
 * A feed with a daily `sites` role and a `detail` role fetched once per id in
 * the sites payload. `detail` is written first so that only the poll's own
 * ordering, not the feed's, can put the sites request ahead of it.
 */
function harness(operator: string, opts: { tolerant?: boolean; status?: boolean } = {}) {
  const definition: FeedDefinition = {
    operator,
    product: "fuel",
    name: "Test stations",
    format: FORMAT,
    tier: "authoritative",
    endpoints: {
      detail: {
        url: `https://example.test/${operator}/stations/{item}`,
        cadenceSec: 300,
        each: { role: "sites", records: "stations", field: "id" },
        ...(opts.tolerant ? { fanout: "tolerant" as const } : {}),
      },
      sites: { url: `https://example.test/${operator}/sites.json`, cadenceSec: DAY / 1000 },
      ...(opts.status
        ? { status: { url: `https://example.test/${operator}/status.json`, cadenceSec: 300 } }
        : {}),
    },
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "Test stations",
    privacyUrl: "https://example.test/privacy",
  };
  const feed = toCatalogFeed(definition, {
    domain: "fuel",
    region: "de",
    file: "feeds/fuel/de.jsonc",
    maintainers: [],
  });
  const roles = createRoleState();
  const answer = { sitesFail: false, ids: ["a", "b"], failIds: [] as string[] };
  const requested: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith("/sites.json")) {
      requested.push("sites");
      if (answer.sitesFail) throw new Error("connect ECONNRESET");
      return new Response(JSON.stringify({ stations: answer.ids.map((id) => ({ id })) }));
    }
    if (href.endsWith("/status.json")) {
      requested.push("status");
      return new Response(JSON.stringify({ stations: [] }));
    }
    const id = href.slice(href.lastIndexOf("/") + 1);
    requested.push(`detail:${id}`);
    if (answer.failIds.includes(id)) return new Response("upstream error", { status: 503 });
    return new Response(JSON.stringify({ id, lon: 8, lat: 50 }));
  }) as typeof globalThis.fetch;
  const tick = (offsetMs: number) =>
    runSource(feed, {
      sql,
      fetch,
      now: () => at(offsetMs),
      lookup: fakeLookup,
      model: { registry, instanceId: "test.local" },
      roles,
    });
  const liveFeatures = async () =>
    (
      await sql<{ id: string }[]>`
        SELECT id FROM conditions.feature
         WHERE source_id = ${feed.id} AND tombstoned_at IS NULL ORDER BY id`
    ).map((r) => r.id.slice(r.id.lastIndexOf(":") + 1));
  const lastAttempt = async () => {
    const [row] = await sql<{ outcome: string; error: string | null }[]>`
      SELECT outcome, error FROM conditions.source_poll_attempt
       WHERE source = ${feed.id} ORDER BY id DESC LIMIT 1`;
    return row!;
  };
  return { answer, requested, tick, liveFeatures, lastAttempt };
}

describe("poll of a feed with a per-item role", () => {
  it("fetches the source first, then one request per id of that poll's payload", async () => {
    const h = harness("each-fresh");
    const result = await h.tick(0);
    expect(result.error).toBeUndefined();
    expect(h.requested).toEqual(["sites", "detail:a", "detail:b"]);
    expect(await h.liveFeatures()).toEqual(["a", "b"]);

    // The next day both are due again: the ids come from the new sites payload.
    h.answer.ids = ["b", "c"];
    h.requested.length = 0;
    const next = await h.tick(DAY);
    expect(next.error).toBeUndefined();
    expect(h.requested).toEqual(["sites", "detail:b", "detail:c"]);
  }, 60_000);

  it("fetches the other roles before the per-item sweep, so their payloads date from the poll's start", async () => {
    // A long sweep (Digitraffic's ~800 details at 60 a minute) would otherwise
    // fetch a role of current states minutes after the time the poll is read as of.
    const h = harness("each-order", { status: true });
    const result = await h.tick(0);
    expect(result.error).toBeUndefined();
    expect(h.requested).toEqual(["sites", "status", "detail:a", "detail:b"]);
  }, 60_000);

  it("uses the held sites payload when the source is not due", async () => {
    const h = harness("each-held-notdue");
    await h.tick(0);
    h.requested.length = 0;
    // The sites changed upstream, but are not asked for again until their cadence.
    h.answer.ids = ["z"];
    const result = await h.tick(300_000);
    expect(result.error).toBeUndefined();
    expect(h.requested).toEqual(["detail:a", "detail:b"]);
  }, 60_000);

  it("uses the held sites payload when the source fails", async () => {
    const h = harness("each-held-failed");
    await h.tick(0);
    h.requested.length = 0;
    h.answer.sitesFail = true;
    const result = await h.tick(DAY);
    expect(result.error).toBeUndefined();
    expect(h.requested).toEqual(["sites", "detail:a", "detail:b"]);
    expect(await h.liveFeatures()).toEqual(["a", "b"]);
  }, 60_000);

  it("a tolerant role publishes the items that answered when one fails, holding none yet", async () => {
    const h = harness("each-partial-first", { tolerant: true });
    h.answer.ids = ["a", "b", "c"];
    h.answer.failIds = ["b"];
    const result = await h.tick(0);
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("changed");
    expect(h.requested).toEqual(["sites", "detail:a", "detail:b", "detail:c"]);
    expect(await h.liveFeatures()).toEqual(["a", "c"]);
    expect((await h.lastAttempt()).error).toMatch(/detail: 1\/3 items failed/);

    // The role answered: it is not due again before its cadence.
    h.requested.length = 0;
    await h.tick(60_000);
    expect(h.requested).toEqual([]);
  }, 60_000);

  it("a tolerant role publishes this poll's items over its held payload when one fails", async () => {
    const h = harness("each-partial-held", { tolerant: true });
    h.answer.ids = ["a", "b", "c"];
    await h.tick(0);
    expect(await h.liveFeatures()).toEqual(["a", "b", "c"]);

    h.answer.failIds = ["c"];
    h.requested.length = 0;
    const result = await h.tick(300_000);
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("changed");
    expect((await h.lastAttempt()).error).toMatch(/detail: 1\/3 items failed/);
    expect(h.requested).toEqual(["detail:a", "detail:b", "detail:c"]);
    expect(await h.liveFeatures()).toEqual(["a", "b"]);

    h.requested.length = 0;
    await h.tick(360_000);
    expect(h.requested).toEqual([]);
  }, 60_000);

  it("fails the poll when the source has neither a fresh nor a held payload", async () => {
    const h = harness("each-none");
    h.answer.sitesFail = true;
    const result = await h.tick(0);
    expect(result.error).toMatch(/no sites payload/);
    expect(h.requested).toEqual(["sites"]);
    expect(await h.liveFeatures()).toEqual([]);
    const attempt = await h.lastAttempt();
    expect(attempt.outcome).toBe("failed");
    expect(attempt.error).toMatch(/no sites payload/);
  }, 60_000);
});
