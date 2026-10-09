import { runMigrations } from "@openconditions/core/server";
import {
  type CatalogFeed,
  defineIngestDomain,
  emptyParseOutput,
  type FeedDefinition,
  type HeldPayload,
  type IngestDomain,
  type LookupFn,
  type ParseContext,
  type ParseOutput,
  type StatusIndex,
  type StatusOutput,
  type StatusSubject,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import {
  buildRegistry,
  extendVocabulary,
  observationId,
  type Registry,
} from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  sweepRecords,
} from "@openconditions/storage";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoleState, runSource } from "../pipeline/run.js";
import { ORPHAN_MAX_AGE_SEC, orphanMaxAges } from "../record-jobs.js";

type Rec = Record<string, unknown>;

const FORMAT = "station-list";

/** A JSON list of `{ id, lon, lat, e5 }` stations as fuel stations with one price each. */
function parseStations(feed: CatalogFeed, payloads: Readonly<Record<string, readonly Buffer[]>>) {
  return stationsAt(feed, payloads, "2026-10-03T10:00:00Z");
}

/** The stations of a `main` payload, their prices read at `fetchedAt`. */
function stationsAt(
  feed: CatalogFeed,
  payloads: Readonly<Record<string, readonly Buffer[]>>,
  fetchedAt: string,
) {
  const out = emptyParseOutput();
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
/** Sites, and an optional status role (Slovenia's shape). */
const OPTIONAL_STATUS_FORMAT = "station-sites-optional-status";
/** Sites, and an optional status role whose answers hold only the latest changes. */
const CHANGES_FORMAT = "station-sites-changes";

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

/** Sites, and a status role read alone through `parseStatus` when the sites are not due. */
const LIVE_FORMAT = "station-sites-live";
/** As {@link LIVE_FORMAT}, its status answers holding only the latest changes. */
const LIVE_CHANGES_FORMAT = "station-sites-live-changes";

/** The full parse of a live format: the joined stations, and an index of their ids. */
const parseLive = vi.fn(
  (feed: CatalogFeed, payloads: Readonly<Record<string, readonly Buffer[]>>): ParseOutput => {
    const out = parseSitesAndStatus(feed, payloads);
    const index = new Map<string, StatusSubject[]>();
    for (const draft of out.features) {
      const stationId = String((draft["provenance"] as { recordId: string }).recordId);
      index.set(stationId, [{ stationId }]);
    }
    return { ...out, statusIndex: index };
  },
);

/** The readings the full parse gives the stations a status answer names; others are rejected. */
const parseLiveStatus = vi.fn(
  (
    feed: CatalogFeed,
    payloads: Readonly<Record<string, readonly Buffer[]>>,
    ctx: ParseContext,
    index: StatusIndex,
  ): StatusOutput => {
    const prices = Object.assign(
      {},
      ...(payloads["status"] ?? []).map((b) => JSON.parse(b.toString("utf8")) as object),
    ) as Record<string, string>;
    const known = Object.keys(prices).filter((id) => index.has(id));
    const lonLat = new Map(
      [...index.keys()].map((id, i) => [id, { lon: 8 + i / 100, lat: 50 }] as const),
    );
    // A status answer carries no time: its readings are as of the fetch.
    const out = stationsAt(
      feed,
      {
        main: [
          Buffer.from(
            JSON.stringify(known.map((id) => ({ id, ...lonLat.get(id), e5: prices[id] }))),
          ),
        ],
      },
      ctx.fetchedAt,
    );
    return {
      observations: out.observations,
      rejected: Object.keys(prices).length - known.length,
    };
  },
);

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
    [OPTIONAL_STATUS_FORMAT]: {
      id: OPTIONAL_STATUS_FORMAT,
      kind: "features",
      products: ["fuel"],
      endpoints: { sites: { required: true }, status: { required: false } },
      parse: parseSitesAndStatus,
    },
    [CHANGES_FORMAT]: {
      id: CHANGES_FORMAT,
      kind: "features",
      products: ["fuel"],
      endpoints: {
        sites: { required: true },
        status: { required: false, accumulatesSince: "sites", changesWindowSec: 600 },
      },
      parse: parseSitesAndStatus,
    },
    [LIVE_FORMAT]: {
      id: LIVE_FORMAT,
      kind: "features",
      products: ["fuel"],
      endpoints: { sites: { required: true }, status: { required: false, status: true } },
      parse: parseLive,
      parseStatus: parseLiveStatus,
    },
    [LIVE_CHANGES_FORMAT]: {
      id: LIVE_CHANGES_FORMAT,
      kind: "features",
      products: ["fuel"],
      endpoints: {
        sites: { required: true },
        status: {
          required: false,
          status: true,
          accumulatesSince: "sites",
          changesWindowSec: 600,
        },
      },
      parse: parseLive,
      parseStatus: parseLiveStatus,
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
    entries: [
      extendVocabulary({
        vocabulary: "source_format",
        values: [
          FORMAT,
          TWO_ROLE_FORMAT,
          OPTIONAL_STATUS_FORMAT,
          CHANGES_FORMAT,
          LIVE_FORMAT,
          LIVE_CHANGES_FORMAT,
        ],
      }),
    ],
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
function sitesAndStatusFeed(operator: string, format = TWO_ROLE_FORMAT): CatalogFeed {
  const definition: FeedDefinition = {
    operator,
    product: "fuel",
    name: "Test stations",
    format,
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
  function sitesHarness(name: string, format = TWO_ROLE_FORMAT) {
    const feed = sitesAndStatusFeed(name, format);
    const roles = createRoleState();
    const answer = {
      sitesFails: false,
      statusFails: false,
      ids: ["a", "b"],
      price: "1.700",
      /** The status answer; every station at `price` when unset. */
      status: undefined as Record<string, string> | undefined,
      /** The sites answer 304 to a request that names their ETag. */
      sitesUnchanged: false,
      /** How many 304s the sites answered. */
      notModified: 0,
    };
    const requested: string[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      requested.push(href.endsWith("/sites.json") ? "sites" : "status");
      if (href.endsWith("/sites.json")) {
        if (answer.sitesFails) throw new Error("connect ECONNRESET");
        if (answer.sitesUnchanged && new Headers(init?.headers).get("if-none-match") === '"s1"') {
          answer.notModified++;
          return new Response(null, { status: 304 });
        }
        return new Response(
          JSON.stringify(answer.ids.map((id, i) => ({ id, lon: 8 + i / 100, lat: 50 }))),
          { headers: { etag: '"s1"' } },
        );
      }
      if (answer.statusFails) throw new Error("connect ETIMEDOUT");
      return new Response(
        JSON.stringify(
          answer.status ?? Object.fromEntries(answer.ids.map((id) => [id, answer.price])),
        ),
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
    /** Each station's price, by station id. */
    const priceOf = async () =>
      Object.fromEntries(
        (
          await sql<{ station: string; price: string }[]>`
            SELECT split_part(feature_id, ':', 4) AS station,
                   reading->'result'->>'amount' AS price
              FROM conditions.observation_latest WHERE source_id = ${feed.id}`
        ).map((r) => [r.station, r.price]),
      );
    return { feed, roles, answer, requested, tick, liveFeatures, prices, priceOf, lastAttempt };
  }

  it("an optional role that fails with nothing held leaves the poll to publish without it", async () => {
    const h = sitesHarness("optional-status", CHANGES_FORMAT);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.answer.statusFails = true;
      const result = await h.tick(0);
      expect(result.error).toBeUndefined();
      expect(result.outcome).toBe("changed");
      expect(await h.liveFeatures()).toHaveLength(2);
      expect(await h.prices()).toEqual(["1.999"]);
      expect((await h.lastAttempt()).error).toMatch(/^status: .*ETIMEDOUT.* \(left out\)$/);
      // The role stays due: the next tick asks for it again.
      h.answer.statusFails = false;
      h.requested.length = 0;
      await h.tick(300_000);
      expect(h.requested).toEqual(["status"]);
      expect(await h.prices()).toEqual(["1.700"]);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it("a daily snapshot's sites outlive an hour of failing status polls, not an overdue snapshot", async () => {
    const h = sitesHarness("snapshot-age", OPTIONAL_STATUS_FORMAT);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sweep = (offsetMs: number) =>
      sweepRecords(sql, {
        registry,
        instanceId: "test.local",
        now: at(offsetMs),
        maxAgeSec: ORPHAN_MAX_AGE_SEC,
        sourceMaxAgeSec: orphanMaxAges([h.feed]),
        historyDays: 90,
      });
    try {
      // Twice the daily snapshot's cadence; a feed polled every five minutes keeps the hour.
      expect(orphanMaxAges([h.feed])).toEqual({ [h.feed.id]: 2 * 86_400 });
      await h.tick(0);
      // The status endpoint fails for two hours: no poll succeeds.
      h.answer.statusFails = true;
      for (let t = 300_000; t <= 7_200_000; t += 300_000) await h.tick(t);
      await sweep(7_200_000);
      expect(await h.liveFeatures()).toHaveLength(2);
      // Two days without a success: the snapshot is overdue and its sites go.
      await sweep(2 * DAY + 600_000);
      expect(await h.liveFeatures()).toEqual([]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }, 120_000);

  it("a status outage of several windows refetches the snapshot once per window; a 304 snapshot still starts anew", async () => {
    const h = sitesHarness("changes-outage", CHANGES_FORMAT);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.answer.status = { a: "1.800" };
      await h.tick(0);
      // An hour of failing status answers, a tick every five minutes.
      h.answer.statusFails = true;
      const refetched: number[] = [];
      for (let t = 300_000; t <= 3_600_000; t += 300_000) {
        h.requested.length = 0;
        await h.tick(t);
        if (h.requested.includes("sites")) refetched.push(t / 60_000);
      }
      // The ten-minute window passes, the snapshot is due on the next tick,
      // and the window counts again from that refetch.
      expect(refetched).toEqual([20, 40, 60]);

      // One answer comes, then the status fails again until the snapshot is
      // due. It answers 304: the held sites stay, and the change held from
      // before it is dropped all the same.
      h.answer.statusFails = false;
      h.answer.status = { a: "1.880" };
      await h.tick(3_900_000);
      h.answer.statusFails = true;
      h.answer.sitesUnchanged = true;
      for (const t of [4_200_000, 4_500_000, 4_800_000, 5_100_000]) await h.tick(t);
      expect(h.answer.notModified).toBe(1);
      h.answer.statusFails = false;
      h.answer.status = { b: "1.950" };
      h.requested.length = 0;
      await h.tick(5_400_000);
      expect(h.requested).toEqual(["status"]);
      expect(await h.liveFeatures()).toHaveLength(2);
      expect(await h.priceOf()).toEqual({ a: "1.999", b: "1.950" });
    } finally {
      warn.mockRestore();
    }
  }, 120_000);

  it("a role of changes is read with every answer since its snapshot; a gap refetches the snapshot", async () => {
    const h = sitesHarness("changes", CHANGES_FORMAT);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.answer.status = { a: "1.800" };
      await h.tick(0);
      expect(await h.priceOf()).toEqual({ a: "1.800", b: "1.999" });

      // Only b changed since: a keeps the change the first answer held.
      h.answer.status = { b: "1.900" };
      await h.tick(300_000);
      expect(await h.priceOf()).toEqual({ a: "1.800", b: "1.900" });

      // A new snapshot starts the changes afresh.
      h.answer.status = {};
      h.requested.length = 0;
      await h.tick(DAY);
      expect(h.requested).toEqual(["sites", "status"]);
      expect(await h.priceOf()).toEqual({ a: "1.999", b: "1.999" });

      // One failed answer within the publisher's ten-minute window loses
      // nothing: the next answer still holds those changes.
      h.answer.status = { a: "1.850" };
      await h.tick(DAY + 300_000);
      h.answer.statusFails = true;
      await h.tick(DAY + 600_000);
      h.answer.statusFails = false;
      h.answer.status = { b: "1.950" };
      h.requested.length = 0;
      await h.tick(DAY + 900_000);
      expect(h.requested).toEqual(["status"]);
      expect(await h.priceOf()).toEqual({ a: "1.850", b: "1.950" });

      // Failing past the window is a gap: the snapshot is fetched again, and
      // the changes held from before it are dropped even while status fails.
      h.answer.statusFails = true;
      for (const t of [1_200_000, 1_500_000, 1_800_000]) await h.tick(DAY + t);
      h.requested.length = 0;
      await h.tick(DAY + 2_100_000);
      expect(h.requested).toEqual(["sites", "status"]);
      expect(await h.priceOf()).toEqual({ a: "1.999", b: "1.999" });
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

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

describe("status-only polls", () => {
  const T0 = Date.parse("2026-10-07T10:00:00.000Z");
  const DAY = 86_400_000;
  const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

  /** A live sites + status feed, its answers as the test sets them, and its stored state. */
  function liveHarness(name: string, format = LIVE_FORMAT) {
    const feed = sitesAndStatusFeed(name, format);
    let roles = createRoleState();
    const answer = {
      ids: ["a", "b"],
      /** Each answer's prices by station; every station at 1.700 when unset. */
      status: undefined as Record<string, string> | undefined,
      /** Bytes of padding in the sites answer. */
      pad: 0,
      /** The status endpoint does not answer. */
      statusFails: false,
    };
    const requested: string[] = [];
    const gate: number[] = [];
    const fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/sites.json")) {
        requested.push("sites");
        const sites = answer.ids.map((id, i) => ({
          id,
          lon: 8 + i / 100,
          lat: 50,
          ...(i === 0 && answer.pad > 0 ? { pad: "x".repeat(answer.pad) } : {}),
        }));
        return new Response(JSON.stringify(sites));
      }
      requested.push("status");
      if (answer.statusFails) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify(answer.status ?? Object.fromEntries(answer.ids.map((id) => [id, "1.700"]))),
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
        parseGate: {
          async run(bytes, task) {
            gate.push(bytes);
            return task();
          },
        },
      });
    const restart = () => {
      roles = createRoleState();
    };
    const records = async (table: "feature" | "offer") =>
      (
        await sql<{ id: string; revision: number }[]>`
          SELECT id, revision FROM ${sql(`conditions.${table}`)}
           WHERE source_id = ${feed.id} AND tombstoned_at IS NULL ORDER BY id`
      ).map((r) => `${r.id}@${r.revision}`);
    const priceOf = async () =>
      Object.fromEntries(
        (
          await sql<{ station: string; price: string }[]>`
            SELECT split_part(feature_id, ':', 4) AS station,
                   reading->'result'->>'amount' AS price
              FROM conditions.observation_latest WHERE source_id = ${feed.id}`
        ).map((r) => [r.station, r.price]),
      );
    const status = async () => {
      const [row] = await sql<
        { last_outcome: string; last_success_at: Date; last_row_count: number }[]
      >`SELECT last_outcome, last_success_at, last_row_count FROM conditions.source_status
         WHERE source = ${feed.id}`;
      return row!;
    };
    return {
      feed,
      roles: () => roles,
      answer,
      requested,
      gate,
      tick,
      restart,
      records,
      priceOf,
      status,
    };
  }

  afterEach(() => {
    parseLive.mockClear();
    parseLiveStatus.mockClear();
  });

  it("a status tick writes the new readings without parsing the snapshot; features and offers stay", async () => {
    const h = liveHarness("live-status");
    await h.tick(0);
    expect(parseLive).toHaveBeenCalledTimes(1);
    const features = await h.records("feature");
    const offers = await h.records("offer");
    expect(features).toHaveLength(2);
    expect(offers).toHaveLength(2);

    h.answer.status = { a: "1.810", b: "1.820", gone: "1.000" };
    h.requested.length = 0;
    h.gate.length = 0;
    const result = await h.tick(300_000);

    expect(h.requested).toEqual(["status"]);
    expect(parseLive).toHaveBeenCalledTimes(1);
    expect(parseLiveStatus).toHaveBeenCalledTimes(1);
    expect(Object.keys(parseLiveStatus.mock.calls[0]![1])).toEqual(["status"]);
    expect(result).toMatchObject({ outcome: "changed", rejected: 1 });
    expect(result.error).toBeUndefined();
    expect(await h.priceOf()).toEqual({ a: "1.810", b: "1.820" });
    expect(await h.records("feature")).toEqual(features);
    expect(await h.records("offer")).toEqual(offers);
    // A successful poll: the source is fresh, and its row count is still its sites.
    const after = await h.status();
    expect(after.last_outcome).toBe("changed");
    expect(after.last_success_at.toISOString()).toBe(at(300_000));
    expect(after.last_row_count).toBe(2);
    // Only the status answer's bytes are weighed for the gate.
    expect(h.gate).toEqual([JSON.stringify(h.answer.status).length]);
  }, 60_000);

  it("a status tick restating every status writes no reading; a change is dated by its fetch", async () => {
    const h = liveHarness("live-unchanged");
    await h.tick(0);
    h.answer.status = { a: "1.810", b: "1.820" };
    await h.tick(300_000);
    const latest = async () => {
      const rows = await sql<{ station: string; effective_from: Date }[]>`
        SELECT split_part(feature_id, ':', 4) AS station, effective_from
          FROM conditions.observation_latest WHERE source_id = ${h.feed.id} ORDER BY station`;
      return Object.fromEntries(rows.map((r) => [r.station, r.effective_from.toISOString()]));
    };
    const history = async () => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conditions.observation o
          JOIN conditions.observation_latest l USING (series_id)
         WHERE l.source_id = ${h.feed.id}`;
      return row!.n;
    };
    const updated = async () => {
      const [row] = await sql<{ last_updated: number }[]>`
        SELECT last_updated FROM conditions.source_status WHERE source = ${h.feed.id}`;
      return row!.last_updated;
    };
    expect(await latest()).toEqual({ a: at(300_000), b: at(300_000) });
    const kept = await history();

    // The same statuses again: nothing is written, the poll still succeeds.
    await h.tick(600_000);
    expect(await updated()).toBe(0);
    expect(await latest()).toEqual({ a: at(300_000), b: at(300_000) });
    expect(await history()).toBe(kept);
    expect((await h.status()).last_success_at.toISOString()).toBe(at(600_000));

    // One status changes: only it is written, as of the fetch that saw it.
    h.answer.status = { a: "1.830", b: "1.820" };
    await h.tick(900_000);
    expect(await updated()).toBe(1);
    expect(await latest()).toEqual({ a: at(900_000), b: at(300_000) });
    expect(await history()).toBe(kept + 1);
  }, 60_000);

  it("a full poll ends the readings of a station it no longer holds; a status tick ends none", async () => {
    const h = liveHarness("live-ended");
    await h.tick(0);
    const validity = async () =>
      Object.fromEntries(
        (
          await sql<{ station: string; valid_until: string | null }[]>`
            SELECT split_part(feature_id, ':', 4) AS station,
                   conditions.observation_record(template, reading) ->> 'validUntil' AS valid_until
              FROM conditions.observation_latest WHERE source_id = ${h.feed.id}`
        ).map((r) => [r.station, r.valid_until]),
      );
    // A status answer naming a alone ends nothing: status files are not the register.
    h.answer.status = { a: "1.700" };
    await h.tick(300_000);
    expect(await validity()).toEqual({ a: null, b: null });
    // The day's full parse no longer holds b: its reading stops holding then.
    h.answer.ids = ["a"];
    await h.tick(DAY);
    expect(await validity()).toEqual({ a: null, b: at(DAY) });
  }, 60_000);

  it("a full poll whose status role was left out ends no reading", async () => {
    const h = liveHarness("live-left-out");
    await h.tick(0);
    // A restart holds nothing, and the status endpoint does not answer.
    h.restart();
    h.answer.ids = ["a"];
    h.answer.statusFails = true;
    await h.tick(300_000);
    const ended = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.observation_latest
       WHERE source_id = ${h.feed.id} AND reading ? 'validUntil'`;
    expect(ended[0]!.n).toBe(0);
  }, 60_000);

  it("a tick the snapshot is due on parses in full and refreshes the index", async () => {
    const h = liveHarness("live-refresh");
    await h.tick(0);
    h.answer.ids = ["a", "b", "c"];
    h.answer.status = { a: "1.800", c: "1.830" };
    // The snapshot is not due: c is not in the index yet.
    expect(await h.tick(300_000)).toMatchObject({ rejected: 1 });
    expect(parseLive).toHaveBeenCalledTimes(1);

    h.requested.length = 0;
    await h.tick(DAY);
    expect(h.requested).toEqual(["sites", "status"]);
    expect(parseLive).toHaveBeenCalledTimes(2);
    expect(await h.records("feature")).toHaveLength(3);

    h.answer.status = { c: "1.840" };
    expect(await h.tick(DAY + 300_000)).toMatchObject({ outcome: "changed", rejected: 0 });
    expect(parseLive).toHaveBeenCalledTimes(2);
    expect((await h.priceOf())["c"]).toBe("1.840");
  }, 60_000);

  it("without an index from a full parse a status tick parses in full", async () => {
    const h = liveHarness("live-restart");
    await h.tick(0);
    // A restart: nothing held, every role due.
    h.restart();
    h.requested.length = 0;
    await h.tick(300_000);
    expect(h.requested).toEqual(["sites", "status"]);
    expect(parseLive).toHaveBeenCalledTimes(2);

    // Payloads held but no index: the status tick parses the held snapshot.
    delete h.roles().statusIndex;
    h.answer.status = { a: "1.850", b: "1.860" };
    h.requested.length = 0;
    await h.tick(600_000);
    expect(h.requested).toEqual(["status"]);
    expect(parseLive).toHaveBeenCalledTimes(3);
    expect(parseLiveStatus).not.toHaveBeenCalled();
    expect(await h.priceOf()).toEqual({ a: "1.850", b: "1.860" });
    expect(h.roles().statusIndex).toBeInstanceOf(Map);
  }, 60_000);

  it("a role of changes hands every answer since its snapshot to the status-only parse", async () => {
    const h = liveHarness("live-changes", LIVE_CHANGES_FORMAT);
    h.answer.status = { a: "1.800" };
    await h.tick(0);
    h.answer.status = { b: "1.900" };
    await h.tick(300_000);
    h.answer.status = {};
    await h.tick(600_000);
    expect(parseLive).toHaveBeenCalledTimes(1);
    expect(parseLiveStatus).toHaveBeenCalledTimes(2);
    expect(parseLiveStatus.mock.calls[1]![1]["status"]).toHaveLength(3);
    expect(await h.priceOf()).toEqual({ a: "1.800", b: "1.900" });
  }, 60_000);

  it("keeps only the payloads, gzipped when large, and the index between polls", async () => {
    const h = liveHarness("live-held");
    h.answer.pad = 2 * 1024 * 1024;
    await h.tick(0);
    const roles = h.roles();
    expect(Object.keys(roles).sort()).toEqual([
      "answers",
      "failing",
      "items",
      "lastFetchedAt",
      "payloads",
      "statusIndex",
      "urls",
    ]);
    const held = roles.payloads as Record<string, readonly HeldPayload[]>;
    expect(Object.keys(held).sort()).toEqual(["sites", "status"]);
    // Beside each held payload its URL, and no per-item role keeps anything.
    expect(Object.keys(roles.urls).sort()).toEqual(["sites", "status"]);
    expect(roles.urls["sites"]).toHaveLength(1);
    expect(roles.items).toEqual({});
    // Neither role is a tolerant `urls` role: no answer is kept per URL.
    expect(roles.answers).toEqual({});
    const [sites] = held["sites"]!;
    expect(sites).toMatchObject({ gzipped: true });
    expect(sites!.data).toBeInstanceOf(Buffer);
    expect(sites!.bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(sites!.data.length).toBeLessThan(sites!.bytes / 10);
    expect(held["status"]![0]).toMatchObject({ gzipped: false });
    for (const payload of Object.values(held).flat()) {
      expect(Object.keys(payload).sort()).toEqual(["bytes", "data", "gzipped"]);
    }
    expect(roles.statusIndex).toBeInstanceOf(Map);
    expect([...roles.statusIndex!.values()].flat()).toEqual([
      { stationId: "a" },
      { stationId: "b" },
    ]);

    // The held snapshot reads back in full when a status tick has no index.
    delete roles.statusIndex;
    await h.tick(300_000);
    const sitesSeen = parseLive.mock.calls[1]![1]["sites"]![0]!;
    expect(sitesSeen.length).toBe(sites!.bytes);
    expect(await h.records("feature")).toHaveLength(2);
  }, 60_000);
});
