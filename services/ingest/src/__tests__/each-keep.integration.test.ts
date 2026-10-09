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

const FORMAT = "station-items";

/** The role a test feed's stations are read from. */
const STATION_ROLE: Record<string, string> = {};

/** One fuel station per payload of the feed's station role, a JSON `{ id, lon, lat }`. */
function parseStations(feed: CatalogFeed, payloads: Readonly<Record<string, readonly Buffer[]>>) {
  parsed.push(feed.id);
  const out = emptyParseOutput();
  for (const buffer of payloads[STATION_ROLE[feed.id] ?? "detail"] ?? []) {
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
      freshness: { fetchedAt: "2026-10-08T10:00:00Z" },
      access: { audience: "public" },
      details: { kind: "fuel_station", v: 1, productsComplete: true },
    });
  }
  return out;
}

/** The feeds whose payloads were parsed, one entry per parse. */
const parsed: string[] = [];

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
        index: { required: false },
        sites: { required: false },
        detail: { required: true },
        main: { required: true },
        extra: { required: false },
      },
      parse: parseStations,
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
    name: "station-items",
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
    now: new Date("2026-10-08T10:00:00Z"),
  });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

const T0 = Date.parse("2026-10-08T10:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** A test feed over a stub upstream: `serve` answers each request, `requested` lists them. */
function harness(
  operator: string,
  endpoints: FeedDefinition["endpoints"],
  serve: (url: string) => Response,
  over: Partial<FeedDefinition> = {},
  stationRole = "detail",
) {
  const definition: FeedDefinition = {
    operator,
    product: "fuel",
    name: "Test stations",
    format: FORMAT,
    tier: "authoritative",
    homepage: "https://example.test",
    endpoints,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "Test stations",
    privacyUrl: "https://example.test/privacy",
    ...over,
  };
  const feed = toCatalogFeed(definition, {
    domain: "fuel",
    region: "de",
    file: "feeds/fuel/de.jsonc",
    maintainers: [],
  });
  STATION_ROLE[feed.id] = stationRole;
  const roles = createRoleState();
  const requested: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    requested.push(href);
    return serve(href);
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
  return { feed, roles, requested, tick, liveFeatures };
}

const station = (id: string) => new Response(JSON.stringify({ id, lon: 8, lat: 50 }));

/** An Apache-style index line: a link and its modification time. */
const entry = (href: string, modified = "2026-10-08 09:00") =>
  `<img src="/icons/folder.gif" alt="[DIR]"> <a href="${href}">${href}</a>   ${modified}    -\n`;
const page = (lines: string[]) =>
  `<!DOCTYPE HTML>\n<html><body><pre>\n${lines.join("")}</pre></body></html>`;

describe("each keep and held payload age", () => {
  it("a walk lists and fetches again only what changed between polls", async () => {
    const root = "https://dd.example.test/20261008/alerts/";
    const tree = new Map<string, string>([
      [root, page([entry("CWTO/")])],
      [`${root}CWTO/`, page([entry("09/", "2026-10-08 09:10"), entry("10/", "2026-10-08 10:00")])],
      [`${root}CWTO/09/`, page([entry("a.cap")])],
      [`${root}CWTO/10/`, page([entry("b.cap")])],
    ]);
    const h = harness(
      "each-walk",
      {
        index: { url: "https://dd.example.test/{utcDate}/alerts/", cadenceSec: 120 },
        detail: {
          url: "{item}",
          cadenceSec: 120,
          each: {
            role: "index",
            links: [
              'href="([A-Z]{4}/)"',
              'href="(\\d{2}/)"[^>]*>[^<]*</a>\\s+(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})',
              'href="([^"]+\\.cap)"',
            ],
          },
        },
      },
      (url) => {
        const listing = tree.get(url);
        if (listing !== undefined) return new Response(listing);
        const file = /\/([a-z])\.cap$/.exec(url)?.[1];
        return file ? station(file) : new Response("not found", { status: 404 });
      },
    );

    const first = await h.tick(0);
    expect(first.error).toBeUndefined();
    expect(h.requested).toEqual([
      root,
      `${root}CWTO/`,
      `${root}CWTO/09/`,
      `${root}CWTO/10/`,
      `${root}CWTO/09/a.cap`,
      `${root}CWTO/10/b.cap`,
    ]);
    expect(await h.liveFeatures()).toEqual(["a", "b"]);

    // Hour 10 gains c.cap and loses b.cap; hour 09 is unchanged.
    tree.set(
      `${root}CWTO/`,
      page([entry("09/", "2026-10-08 09:10"), entry("10/", "2026-10-08 10:02")]),
    );
    tree.set(`${root}CWTO/10/`, page([entry("c.cap")]));
    h.requested.length = 0;
    const second = await h.tick(120_000);
    expect(second.error).toBeUndefined();
    // Hour 09 is listed once more: its minute-resolution version is trusted only once it repeats.
    expect(h.requested).toEqual([
      root,
      `${root}CWTO/`,
      `${root}CWTO/09/`,
      `${root}CWTO/10/`,
      `${root}CWTO/10/c.cap`,
    ]);
    expect(await h.liveFeatures()).toEqual(["a", "c"]);
    // The source and office listings are kept too, to stand in should they fail to answer.
    expect([...(h.roles.items["detail"]?.keys() ?? [])].sort()).toEqual([
      root,
      `${root}CWTO/`,
      `${root}CWTO/09/`,
      `${root}CWTO/09/a.cap`,
      `${root}CWTO/10/`,
      `${root}CWTO/10/c.cap`,
    ]);
    // The source's URL is held beside its payload for the next poll.
    expect(h.roles.urls["index"]).toEqual([root]);

    // Nothing changed: hour 10's new version is confirmed once, hour 09 is trusted.
    h.requested.length = 0;
    expect((await h.tick(240_000)).error).toBeUndefined();
    expect(h.requested).toEqual([root, `${root}CWTO/`, `${root}CWTO/10/`]);
    h.requested.length = 0;
    expect((await h.tick(360_000)).error).toBeUndefined();
    expect(h.requested).toEqual([root, `${root}CWTO/`]);
  }, 60_000);

  describe("a walk whose office listing fails", () => {
    const root = "https://dd.example.test/20261008/alerts/";
    const LINKS = [
      'href="([A-Z]{4}/)"',
      'href="(\\d{2}/)"[^>]*>[^<]*</a>\\s+(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})',
      'href="([^"]+\\.cap)"',
    ];
    /** Two offices, CWTO with a.cap and CWUL with b.cap; `down` URLs answer 503. */
    function offices(operator: string, down: Set<string>) {
      const tree = new Map<string, string>([
        [root, page([entry("CWTO/"), entry("CWUL/")])],
        [`${root}CWTO/`, page([entry("09/", "2026-10-08 09:10")])],
        [`${root}CWUL/`, page([entry("09/", "2026-10-08 09:20")])],
        [`${root}CWTO/09/`, page([entry("a.cap")])],
        [`${root}CWUL/09/`, page([entry("b.cap")])],
      ]);
      return harness(
        operator,
        {
          index: { url: "https://dd.example.test/{utcDate}/alerts/", cadenceSec: 120 },
          detail: {
            url: "{item}",
            cadenceSec: 120,
            fanout: "tolerant",
            each: { role: "index", links: LINKS },
          },
        },
        (url) => {
          if (down.has(url)) return new Response("upstream error", { status: 503 });
          const listing = tree.get(url);
          if (listing !== undefined) return new Response(listing);
          const file = /\/([a-z])\.cap$/.exec(url)?.[1];
          return file ? station(file) : new Response("not found", { status: 404 });
        },
      );
    }

    it("with nothing kept (a restart), the poll is partial and the last publication stands", async () => {
      const down = new Set<string>();
      const before = offices("walk-cold", down);
      expect((await before.tick(0)).error).toBeUndefined();
      expect(await before.liveFeatures()).toEqual(["a", "b"]);

      // A restarted process holds nothing, and one office listing fails.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        down.add(`${root}CWUL/`);
        const after = offices("walk-cold", down);
        const result = await after.tick(120_000);
        expect(result.outcome).toBe("partial");
        expect(result.error).toMatch(/partial snapshot: 1\/\d+ partitions failed/);
        expect(await after.liveFeatures()).toEqual(["a", "b"]);
        // What answered is kept for the next poll all the same.
        expect(after.roles.items["detail"]?.has(`${root}CWTO/09/a.cap`)).toBe(true);
      } finally {
        warn.mockRestore();
      }
    }, 60_000);

    it("with a kept copy, the copy stands in and the poll publishes", async () => {
      const down = new Set<string>();
      const h = offices("walk-kept", down);
      expect((await h.tick(0)).error).toBeUndefined();

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        down.add(`${root}CWUL/`);
        h.requested.length = 0;
        const result = await h.tick(120_000);
        expect(result.error).toBeUndefined();
        expect(result.outcome).not.toBe("partial");
        expect(h.requested).toContain(`${root}CWUL/`);
        expect(await h.liveFeatures()).toEqual(["a", "b"]);
      } finally {
        warn.mockRestore();
      }
    }, 60_000);
  });

  it("an item kept for keepSec is not asked again, and leaves once no record names it", async () => {
    let ids = ["a", "b"];
    const h = harness(
      "each-keep",
      {
        sites: { url: "https://example.test/each-keep/sites.json", cadenceSec: 30 },
        detail: {
          url: "https://example.test/each-keep/stations/{item}",
          cadenceSec: 30,
          each: { role: "sites", records: "stations", field: "id", keepSec: 60 },
        },
      },
      (url) =>
        url.endsWith("/sites.json")
          ? new Response(JSON.stringify({ stations: ids.map((id) => ({ id })) }))
          : station(url.slice(url.lastIndexOf("/") + 1)),
    );
    const details = () => h.requested.filter((u) => u.includes("/stations/"));

    expect((await h.tick(0)).error).toBeUndefined();
    expect(details()).toHaveLength(2);

    h.requested.length = 0;
    const second = await h.tick(40_000);
    expect(second.error).toBeUndefined();
    expect(h.requested).toEqual(["https://example.test/each-keep/sites.json"]);
    expect(await h.liveFeatures()).toEqual(["a", "b"]);

    ids = ["b"];
    h.requested.length = 0;
    await h.tick(55_000);
    expect(details()).toEqual([]);
    expect([...(h.roles.items["detail"]?.keys() ?? [])]).toEqual([
      "https://example.test/each-keep/stations/b",
    ]);
    expect(await h.liveFeatures()).toEqual(["b"]);

    // Past keepSec (kept since the first poll) the item is asked again.
    h.requested.length = 0;
    await h.tick(70_000);
    expect(details()).toEqual(["https://example.test/each-keep/stations/b"]);
  }, 60_000);

  describe("maxPayloadAgeSec", () => {
    function aged(operator: string) {
      const answer = { mainFails: false, extraFails: false };
      const h = harness(
        operator,
        {
          main: {
            url: `https://example.test/${operator}/main.json`,
            cadenceSec: 60,
            maxPayloadAgeSec: 300,
          },
          extra: { url: `https://example.test/${operator}/extra.json`, cadenceSec: 60 },
        },
        (url) => {
          if (url.endsWith("/main.json")) {
            if (answer.mainFails) return new Response("upstream error", { status: 503 });
            return station("m");
          }
          if (answer.extraFails) return new Response("upstream error", { status: 503 });
          return new Response("{}");
        },
        {},
        "main",
      );
      return { ...h, answer };
    }

    it("a role without maxPayloadAgeSec keeps its held payload at any age", async () => {
      const h = aged("held-reference");
      expect((await h.tick(0)).error).toBeUndefined();
      h.answer.extraFails = true;
      // Ten days on, the role whose answers may age still fails over to its held copy.
      const result = await h.tick(10 * 86_400_000);
      expect(result.error).toBeUndefined();
      expect(h.roles.payloads["extra"]).toBeDefined();
      expect(await h.liveFeatures()).toEqual(["m"]);
    }, 60_000);

    it("a held payload younger than maxPayloadAgeSec stands in for a failed role", async () => {
      const h = aged("held-young");
      expect((await h.tick(0)).error).toBeUndefined();
      h.answer.mainFails = true;
      const before = parsed.filter((id) => id === h.feed.id).length;
      const result = await h.tick(299_000);
      expect(result.error).toBeUndefined();
      expect(parsed.filter((id) => id === h.feed.id).length).toBe(before + 1);
      expect(h.roles.payloads["main"]).toBeDefined();
    }, 60_000);

    it("a held payload older than maxPayloadAgeSec is never parsed: the role fails with nothing held", async () => {
      const h = aged("held-old");
      expect((await h.tick(0)).error).toBeUndefined();
      h.answer.mainFails = true;
      const before = parsed.filter((id) => id === h.feed.id).length;
      const result = await h.tick(301_000);
      expect(result.error).toMatch(/HTTP 503/);
      expect(parsed.filter((id) => id === h.feed.id).length).toBe(before);
      expect(h.roles.payloads["main"]).toBeUndefined();
      expect(await h.liveFeatures()).toEqual(["m"]);
    }, 60_000);
  });
});
