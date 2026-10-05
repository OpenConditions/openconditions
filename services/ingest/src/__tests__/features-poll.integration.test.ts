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
import {
  buildRegistry,
  extendVocabulary,
  observationId,
  type Registry,
} from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import { ensureObservationPartitions, retentionClasses } from "@openconditions/storage";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoleState, runSource } from "../pipeline/run.js";

type Rec = Record<string, unknown>;

const FORMAT = "station-list";

/** A JSON list of `{ id, lon, lat, e5 }` stations as fuel stations with one price each. */
function parseStations(feed: CatalogFeed, payloads: Readonly<Record<string, readonly Buffer[]>>) {
  const out = emptyParseOutput();
  const fetchedAt = "2026-10-03T10:00:00Z";
  for (const buffer of payloads["main"] ?? []) {
    const stations = JSON.parse(buffer.toString("utf8")) as {
      id: string;
      lon: number;
      lat: number;
      e5: string;
    }[];
    for (const s of stations) {
      const featureId = `oc:feature:${feed.id}:${s.id}`;
      const provenance = {
        origin: "feed",
        sourceId: feed.id,
        sourceFormat: FORMAT,
        accessMode: "bulk",
        recordId: s.id,
        attribution: { provider: "payload claim", license: "payload claim" },
        privacy: { class: "authoritative" },
      };
      const location = {
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      };
      out.features.push({
        id: featureId,
        class: "feature",
        kind: "fuel_station",
        temporality: "static",
        lifecycle: "operational",
        name: [{ lang: "de", text: `Station ${s.id}` }],
        location,
        provenance,
        freshness: { fetchedAt },
        access: { audience: "public" },
        components: [
          {
            key: "e5",
            kind: "fuel_product",
            details: {
              kind: "fuel_product",
              v: 1,
              grade: "e5",
              per: "L",
              priceBasis: "gross",
              priceLevel: "standard",
              vehicleScope: "any",
            },
          },
        ],
        details: { kind: "fuel_station", v: 1, productsComplete: true },
      });
      const price: Rec = {
        class: "observation",
        kind: "observation",
        temporality: "live",
        location,
        provenance,
        freshness: { fetchedAt },
        property: "fuel.price",
        subject: { kind: "feature", featureId, componentKey: "e5" },
        result: { type: "money", amount: s.e5, currency: "EUR", per: "L" },
        phenomenonTime: { instant: fetchedAt },
        aggregation: "instantaneous",
      };
      price["id"] = observationId(feed.id, price as never);
      out.observations.push(price);
      out.offers.push({
        id: `oc:offer:${feed.id}:${s.id}`,
        class: "offer",
        kind: "energy_tariff",
        temporality: "static",
        location,
        provenance,
        freshness: { fetchedAt },
        subject: { class: "feature", id: featureId },
        currency: "EUR",
        elements: [{ components: [{ type: "energy", price: { amount: s.e5, currency: "EUR" } }] }],
        priceIncludesVat: true,
        validity: { status: "active" },
      });
    }
  }
  return out;
}

const TWO_ROLE_FORMAT = "station-sites-status";

/**
 * A daily `sites` payload (a JSON list of `{ id, lon, lat }`) and a 5-minute
 * `status` payload (a JSON object of price by station id), joined into the
 * stations the single-role parser reads.
 */
function parseSitesAndStatus(
  feed: CatalogFeed,
  payloads: Readonly<Record<string, readonly Buffer[]>>,
) {
  const sites = (payloads["sites"] ?? []).flatMap(
    (b) => JSON.parse(b.toString("utf8")) as { id: string; lon: number; lat: number }[],
  );
  const prices = Object.assign(
    {},
    ...(payloads["status"] ?? []).map((b) => JSON.parse(b.toString("utf8")) as object),
  ) as Record<string, string>;
  const joined = sites.map((s) => ({ ...s, e5: prices[s.id] ?? "1.999" }));
  return parseStations(feed, { main: [Buffer.from(JSON.stringify(joined))] });
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
      endpoints: { main: { required: true } },
      parse: parseStations,
    },
    [TWO_ROLE_FORMAT]: {
      id: TWO_ROLE_FORMAT,
      kind: "features",
      products: ["fuel"],
      endpoints: { sites: { required: true }, status: { required: true } },
      parse: parseSitesAndStatus,
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
    name: "station-list",
    entries: [extendVocabulary({ vocabulary: "source_format", values: [FORMAT, TWO_ROLE_FORMAT] })],
  },
]);

/** A feed of its own (id, source rows and URL), so no test depends on another's state. */
function feedNamed(operator: string): CatalogFeed {
  const definition: FeedDefinition = {
    operator,
    product: "fuel",
    name: "Test stations",
    format: FORMAT,
    tier: "authoritative",
    endpoints: { main: { url: `https://example.test/${operator}.json`, cadenceSec: 300 } },
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "Test stations",
    privacyUrl: "https://example.test/privacy",
  };
  return toCatalogFeed(definition, {
    domain: "fuel",
    region: "de",
    file: "feeds/fuel/de.jsonc",
    maintainers: [],
  });
}

/** A feed with a daily `sites` endpoint and a 5-minute `status` endpoint. */
function sitesAndStatusFeed(operator: string): CatalogFeed {
  const definition: FeedDefinition = {
    operator,
    product: "fuel",
    name: "Test stations",
    format: TWO_ROLE_FORMAT,
    tier: "authoritative",
    endpoints: {
      sites: { url: `https://example.test/${operator}/sites.json`, cadenceSec: 86_400 },
      status: { url: `https://example.test/${operator}/status.json`, cadenceSec: 300 },
    },
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "Test stations",
    privacyUrl: "https://example.test/privacy",
  };
  return toCatalogFeed(definition, {
    domain: "fuel",
    region: "de",
    file: "feeds/fuel/de.jsonc",
    maintainers: [],
  });
}

const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

const stations = (...ids: string[]) =>
  JSON.stringify(
    ids.map((id, i) => ({ id, lon: 8 + i / 100, lat: 50 + i / 100, e5: `1.${700 + i}` })),
  );

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

afterEach(() => {
  vi.unstubAllEnvs();
});

/** One test's feed with its polling double and the reads that pin its stored state. */
function harness(name: string) {
  const feed = feedNamed(name);
  const requests: { ifNoneMatch: string | null; status: number }[] = [];
  const poll = (body: string, opts: { etag?: string; notModifiedFor?: string } = {}) =>
    runSource(feed, {
      sql,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const ifNoneMatch = new Headers(init?.headers).get("If-None-Match");
        if (opts.notModifiedFor !== undefined && ifNoneMatch === opts.notModifiedFor) {
          requests.push({ ifNoneMatch, status: 304 });
          return new Response(null, { status: 304 });
        }
        requests.push({ ifNoneMatch, status: 200 });
        return new Response(body, opts.etag ? { headers: { etag: opts.etag } } : {});
      }) as typeof fetch,
      now: () => "2026-10-03T10:00:00Z",
      lookup: fakeLookup,
      model: { registry, instanceId: "test.local" },
    });
  const live = async (table: "feature" | "offer"): Promise<string[]> => {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM ${sql("conditions." + table)}
       WHERE source_id = ${feed.id} AND tombstoned_at IS NULL ORDER BY id`;
    return rows.map((r) => r.id);
  };
  const readings = async (): Promise<number> => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.observation_latest WHERE source_id = ${feed.id}`;
    return row!.n;
  };
  const status = async () => {
    const [row] = await sql<
      { last_outcome: string; last_error: string | null; last_row_count: number }[]
    >`SELECT last_outcome, last_error, last_row_count FROM conditions.source_status
       WHERE source = ${feed.id}`;
    return row!;
  };
  const lastAttempt = async () => {
    const [row] = await sql<{ outcome: string; error: string | null }[]>`
      SELECT outcome, error FROM conditions.source_poll_attempt
       WHERE source = ${feed.id} ORDER BY id DESC LIMIT 1`;
    return row!;
  };
  return { feed, requests, poll, live, readings, status, lastAttempt };
}

describe("features poll", () => {
  it("a features poll publishes features, readings and offers and withdraws a vanished feature", async () => {
    const h = harness("publish");
    const first = await h.poll(stations("a", "b", "c"));
    expect(first.error).toBeUndefined();
    expect(first.outcome).toBe("changed");
    expect(first.activeEvents).toBe(3);
    expect(await h.live("feature")).toHaveLength(3);
    expect(await h.live("offer")).toHaveLength(3);
    expect(await h.readings()).toBe(3);

    const [stamped] = await sql<{ record: Rec }[]>`
      SELECT record FROM conditions.feature WHERE id = ${`oc:feature:${h.feed.id}:a`}`;
    expect((stamped!.record["provenance"] as Rec)["attribution"]).toMatchObject({
      provider: "Test stations",
      license: "CC0-1.0",
    });
    const [offer] = await sql<{ record: Rec }[]>`
      SELECT record FROM conditions.offer WHERE id = ${`oc:offer:${h.feed.id}:a`}`;
    expect((offer!.record["provenance"] as Rec)["attribution"]).toMatchObject({
      provider: "Test stations",
    });
    expect((await h.status()).last_row_count).toBe(3);

    const second = await h.poll(stations("a", "b"));
    expect(second.error).toBeUndefined();
    expect(second.deleted).toBeGreaterThan(0);
    expect(await h.live("feature")).toEqual([
      `oc:feature:${h.feed.id}:a`,
      `oc:feature:${h.feed.id}:b`,
    ]);
    expect(await h.live("offer")).toHaveLength(2);
  }, 60_000);

  it("a features poll that parses no features from a non-empty payload keeps the last publication", async () => {
    const h = harness("zero");
    await h.poll(stations("a", "b"), { etag: '"good"' });
    const result = await h.poll("[]\n", { etag: '"bad"' });
    expect(result.error).toMatch(/produced zero features/);
    expect(result.outcome).toBe("failed");
    expect(result.count).toBe(0);
    expect(await h.live("feature")).toHaveLength(2);
    expect(await h.live("offer")).toHaveLength(2);

    const status = await h.status();
    expect(status.last_outcome).toBe("failed");
    expect(status.last_error).toMatch(/produced zero features/);
    expect(status.last_row_count).toBe(2);
    const attempt = await h.lastAttempt();
    expect(attempt.outcome).toBe("failed");
    expect(attempt.error).toMatch(/produced zero features/);

    // The rejected payload's validator was not accepted: a server answering 304
    // to it is never asked, and the next poll refetches and parses afresh.
    const retry = await h.poll(stations("a", "b"), { etag: '"good"', notModifiedFor: '"bad"' });
    expect(retry.error).toBeUndefined();
    expect(retry.outcome).not.toBe("validated_unchanged");
    expect(h.requests.at(-1)).toEqual({ ifNoneMatch: '"good"', status: 200 });
  }, 60_000);

  it("a features poll that shrinks past the tripwire keeps the last publication", async () => {
    vi.stubEnv("OPENCONDITIONS_SHRINK_TRIPWIRE_RATIO", "0.5");
    const h = harness("shrink");
    await h.poll(stations("a", "b", "c", "d"), { etag: '"good"' });
    const result = await h.poll(stations("a"), { etag: '"shrunk"' });
    expect(result.error).toMatch(/shrank from 4 to 1/);
    expect(await h.live("feature")).toHaveLength(4);

    const status = await h.status();
    expect(status.last_outcome).toBe("failed");
    expect(status.last_error).toMatch(/shrank from 4 to 1/);
    expect(status.last_row_count).toBe(4);
    const attempt = await h.lastAttempt();
    expect(attempt.outcome).toBe("failed");
    expect(attempt.error).toMatch(/shrank from 4 to 1/);

    const retry = await h.poll(stations("a", "b", "c", "d"), {
      etag: '"good"',
      notModifiedFor: '"shrunk"',
    });
    expect(retry.error).toBeUndefined();
    expect(retry.outcome).not.toBe("validated_unchanged");
    expect(h.requests.at(-1)).toEqual({ ifNoneMatch: '"good"', status: 200 });
  }, 60_000);
});

describe("features poll with a slow endpoint", () => {
  const T0 = Date.parse("2026-10-03T10:00:00.000Z");
  const DAY = 86_400_000;
  const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

  /** A sites + status feed whose endpoints each answer, or fail, as the test sets. */
  function sitesHarness(name: string) {
    const feed = sitesAndStatusFeed(name);
    const roles = createRoleState();
    const answer = { sitesFails: false, statusFails: false, ids: ["a", "b"], price: "1.700" };
    const requested: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      requested.push(href.endsWith("/sites.json") ? "sites" : "status");
      if (href.endsWith("/sites.json")) {
        if (answer.sitesFails) throw new Error("connect ECONNRESET");
        return new Response(
          JSON.stringify(answer.ids.map((id, i) => ({ id, lon: 8 + i / 100, lat: 50 }))),
        );
      }
      if (answer.statusFails) throw new Error("connect ETIMEDOUT");
      return new Response(
        JSON.stringify(Object.fromEntries(answer.ids.map((id) => [id, answer.price]))),
      );
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
      ).map((r) => r.id);
    const prices = async () =>
      (
        await sql<{ price: string }[]>`
          SELECT DISTINCT reading->'result'->>'amount' AS price
            FROM conditions.observation_latest WHERE source_id = ${feed.id}`
      ).map((r) => r.price);
    const lastAttempt = async () => {
      const [row] = await sql<{ outcome: string; error: string | null }[]>`
        SELECT outcome, error FROM conditions.source_poll_attempt
         WHERE source = ${feed.id} ORDER BY id DESC LIMIT 1`;
      return row!;
    };
    return { feed, roles, answer, requested, tick, liveFeatures, prices, lastAttempt };
  }

  it("a failing sites endpoint with a held payload still publishes fresh status readings", async () => {
    const h = sitesHarness("held-sites");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await h.tick(0)).error).toBeUndefined();
      expect(await h.prices()).toEqual(["1.700"]);

      h.answer.sitesFails = true;
      h.answer.price = "1.800";
      h.requested.length = 0;
      const result = await h.tick(DAY);

      expect(result.error).toBeUndefined();
      expect(result.outcome).toBe("changed");
      expect(h.requested).toEqual(["sites", "status"]);
      expect(await h.liveFeatures()).toEqual([
        `oc:feature:${h.feed.id}:a`,
        `oc:feature:${h.feed.id}:b`,
      ]);
      expect(await h.prices()).toEqual(["1.800"]);
      expect(h.roles.lastFetchedAt).toEqual({ sites: T0, status: T0 + DAY });
      expect((await h.lastAttempt()).error).toMatch(
        /^sites: .*ECONNRESET.* \(held payload used\)$/,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toContainEqual({ feed: h.feed.id, role: "sites" });

      // Still failing on the next tick: it publishes again, and does not warn again.
      h.answer.price = "1.900";
      expect((await h.tick(DAY + 300_000)).error).toBeUndefined();
      expect(await h.prices()).toEqual(["1.900"]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it("a poll whose every fetched role fell back to its held payload is no network success", async () => {
    const h = sitesHarness("all-held");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const freshness = async () => {
      const [row] = await sql<
        { freshness_deadline: Date; last_network_success_at: Date; last_outcome: string }[]
      >`
        SELECT freshness_deadline, last_network_success_at, last_outcome
          FROM conditions.source_status WHERE source = ${h.feed.id}`;
      return row!;
    };
    try {
      await h.tick(0);
      const before = await freshness();

      h.answer.sitesFails = true;
      h.answer.statusFails = true;
      const result = await h.tick(DAY);

      expect(result.outcome).not.toBe("validated_unchanged");
      const after = await freshness();
      expect(after.freshness_deadline).toEqual(before.freshness_deadline);
      expect(after.last_network_success_at).toEqual(before.last_network_success_at);
      expect(after.last_outcome).toBe("failed");
      expect((await h.lastAttempt()).error).toMatch(/sites: .*ECONNRESET.*status: .*ETIMEDOUT/);
      // The features stay as published.
      expect(await h.liveFeatures()).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it("a failing sites endpoint with nothing held fails the poll", async () => {
    const h = sitesHarness("nothing-held");
    h.answer.sitesFails = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await h.tick(0);
      expect(result.error).toMatch(/ECONNRESET/);
      expect(result.count).toBe(0);
      expect(await h.liveFeatures()).toEqual([]);
      expect((await h.lastAttempt()).outcome).toBe("failed");
      expect(h.roles.lastFetchedAt).toEqual({});
    } finally {
      error.mockRestore();
    }
  }, 60_000);

  it("the failed role is retried on the next tick", async () => {
    const h = sitesHarness("retried");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.tick(0);
      h.answer.sitesFails = true;
      await h.tick(DAY);

      h.answer.sitesFails = false;
      h.answer.ids = ["a", "b", "c"];
      h.requested.length = 0;
      const result = await h.tick(DAY + 300_000);

      expect(result.error).toBeUndefined();
      expect(h.requested).toEqual(["sites", "status"]);
      expect(await h.liveFeatures()).toHaveLength(3);
      expect(h.roles.lastFetchedAt).toEqual({
        sites: T0 + DAY + 300_000,
        status: T0 + DAY + 300_000,
      });
      expect((await h.lastAttempt()).error).toBeNull();

      // A later outage warns afresh.
      h.answer.sitesFails = true;
      await h.tick(2 * DAY + 600_000);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});
