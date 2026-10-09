import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { type CatalogFeed, type LookupFn, unzipEntries } from "@openconditions/ingest-framework";
import {
  ensureObservationPartitions,
  retentionClasses,
  sweepRecords,
  syncSources,
} from "@openconditions/storage";
import Fastify, { type FastifyInstance } from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRoleState, type RunResult, runSource } from "../pipeline/run.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { registry } from "./helpers/situations.js";

/**
 * The hazards feeds of the repo catalogue, polled through the pipeline over
 * stub upstreams that serve the hazards package's captures, and read back
 * through the API: alerts that leave when their publisher drops them, zone
 * shapes fetched once, a restricted source served only to the operator,
 * fire pixels written once and swept on expiry, earthquakes read by time
 * window, smoke that outlives its image sequence.
 */

type Rec = Record<string, unknown>;

const FIXTURES = join(import.meta.dirname, "../../../../packages/hazards/src/__tests__/fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const fixtureText = (name: string) => fixture(name).toString("utf8");

const TOKEN = "operator-token-of-the-hazards-pipeline-suite";
const OPERATOR = { authorization: `Bearer ${TOKEN}` };

/** The clock the polls and the API read; each case sets it to when its captures were current. */
let clock = "2026-10-08T21:10:00.000Z";
const later = (iso: string, sec: number) => new Date(Date.parse(iso) + sec * 1000).toISOString();

const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;

const HAZARDS = REPO_CATALOG.feeds.filter((feed) => feed.domain === "hazards");

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now: new Date("2026-10-07T03:00:00Z"),
  });
  await syncSources(
    sql,
    HAZARDS.map((feed) => ({ ...feed })),
  );
  app = Fastify();
  registerScope(app, TOKEN);
  registerApiRoutes(app, sql, { registry, now: () => new Date(clock), catalog: REPO_CATALOG });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

/** A feed of the catalogue polled over `serve`, which answers each request; `requested` lists them. */
function harness(id: string, serve: (url: string) => Response | Promise<Response>) {
  const feed = repoFeed(id) as CatalogFeed;
  const roles = createRoleState();
  const requested: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    const href = String(url instanceof Request ? url.url : url);
    requested.push(href);
    return serve(href);
  }) as typeof globalThis.fetch;
  const poll = (at: string): Promise<RunResult> => {
    clock = at;
    return runSource(feed, {
      sql,
      fetch,
      now: () => at,
      lookup: fakeLookup,
      model: { registry, instanceId: "test.local" },
      roles,
    });
  };
  const live = async () =>
    (
      await sql<{ id: string }[]>`
        SELECT id FROM conditions.situation
         WHERE source_id = ${feed.id} AND tombstoned_at IS NULL ORDER BY id`
    ).map((r) => r.id);
  return { feed, roles, requested, poll, live };
}

const notFound = () =>
  new Response(fixture("nws-zone-fire-AKZ801-404.json"), {
    status: 404,
    headers: { "content-type": "application/problem+json" },
  });

async function get(url: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "GET", url, headers });
  expect(res.statusCode).toBe(200);
  return res.json() as Rec;
}

const ids = (body: Rec) => (body["records"] as Rec[]).map((r) => String(r["id"]));

/** A zip of stored entries, as DWD's status zip holds its CAP files. */
function storedZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("hazards alerts through the pipeline", () => {
  it("us-nws-alerts: zones are fetched once, and a zone-only watch is read by its state's box", async () => {
    const zones: Record<string, string> = {
      "forecast/FLZ019": "nws-zone-forecast-FLZ019.json",
      "county/FLC079": "nws-zone-county-FLC079.json",
      "forecast/PKZ662": "nws-zone-forecast-PKZ662.json",
    };
    const nws = harness("us-nws-alerts", (url) => {
      if (url === "https://api.weather.gov/alerts/active?status=actual") {
        return new Response(fixture("nws-alerts-active.json"));
      }
      const zone = url.replace("https://api.weather.gov/zones/", "");
      return zones[zone] === undefined ? notFound() : new Response(fixture(zones[zone]));
    });
    const zoneRequests = () => nws.requested.filter((u) => u.includes("/zones/"));
    const T = "2026-10-08T21:10:00.000Z";
    const first = await nws.poll(T);
    expect(first.error).toBeUndefined();
    const asked = zoneRequests();
    // The alerts name two of the captured zones; every other zone answers 404.
    const answered = [
      "https://api.weather.gov/zones/forecast/FLZ019",
      "https://api.weather.gov/zones/forecast/PKZ662",
    ];
    expect(asked).toEqual(expect.arrayContaining(answered));

    const second = await nws.poll(later(T, 120));
    expect(second.error).toBeUndefined();
    // Both polls listed the alerts; the second asked no zone that answered again,
    // only the dead ones, whose answer is not kept.
    expect(nws.requested.filter((u) => u.includes("/alerts/"))).toHaveLength(2);
    const again = zoneRequests().slice(asked.length);
    expect(again.filter((u) => answered.includes(u))).toEqual([]);
    expect(again.length).toBe(asked.length - 2);

    const florida = await get("/situations?domain=hazards&kind=alert&bbox=-87.7,24.4,-79.9,31.1");
    const watch = (florida["records"] as Rec[]).find((r) =>
      String(r["id"]).endsWith("8a5c453d4cdae9049a16ae28.001.1"),
    );
    expect(watch).toBeDefined();
    expect(watch!["location"]).toMatchObject({
      geometryOrigin: "derived",
      geometry: { type: expect.stringMatching(/Polygon$/) },
    });
    // The air quality alert's only zone answered 404: it is stored with its
    // geocodes and no shape, so no box read returns it.
    const everywhere = await get("/situations?domain=hazards&kind=alert");
    const air = (everywhere["records"] as Rec[]).find((r) =>
      String(r["id"]).endsWith("337ba839a0526eeac1b8115b.001.1"),
    );
    expect(air!["location"]).toMatchObject({
      geometry: null,
      extent: "area",
      admin: {
        country: "US",
        geocodes: expect.arrayContaining([{ scheme: "ugc", code: "AZC013" }]),
      },
    });
    expect(ids(florida)).not.toContain(air!["id"]);
    // The `Test` message the stub let through is no alert.
    expect((await nws.live()).some((id) => id.includes("KEEPALIVE"))).toBe(false);
  }, 60_000);

  it("de-dwd-alerts: a warning missing from the next status zip is withdrawn", async () => {
    const entries = unzipEntries(fixture("dwd-stat-mul.zip"), {
      maxEntries: 10,
      maxBytes: 1 << 20,
    });
    const gusts = entries.find((e) => e.name.includes(".1791478140000."))!;
    let zip = storedZip(entries);
    const dwd = harness("de-dwd-alerts", () => new Response(new Uint8Array(zip)));
    const T = "2026-10-08T22:00:00.000Z";
    expect((await dwd.poll(T)).error).toBeUndefined();
    // The update replaces the warning it references: two situations, the gusts warning one of them.
    const before = await dwd.live();
    expect(before).toHaveLength(2);
    expect(before.filter((id) => id.includes(".1791478140000."))).toHaveLength(1);

    zip = storedZip(entries.filter((e) => e !== gusts));
    const result = await dwd.poll(later(T, 300));
    expect(result.error).toBeUndefined();
    expect(result.deleted).toBe(1);
    const after = await dwd.live();
    expect(after).toHaveLength(1);
    expect(after.some((id) => id.includes(".1791478140000."))).toBe(false);
  }, 60_000);

  it("de-dwd-alerts: a coast warning named by warn cell only is drawn with DWD's coast areas", async () => {
    const zip = storedZip([
      { name: "coast.MUL.xml", data: fixture("dwd-coast-strong-wind-mul.xml") },
    ]);
    const dwd = harness("de-dwd-alerts", (url) => {
      if (url.includes("typeNames=dwd:Warngebiete_Kueste")) {
        return new Response(fixture("dwd-areas-coast.json"));
      }
      if (url.includes("typeNames=dwd:Warngebiete_Binnenseen")) {
        return new Response(fixture("dwd-areas-lakes.json"));
      }
      return new Response(new Uint8Array(zip));
    });
    expect((await dwd.poll("2026-10-09T15:00:00.000Z")).error).toBeUndefined();
    const [id] = await dwd.live();
    const [row] = await sql<{ record: Rec }[]>`
      SELECT record FROM conditions.situation WHERE id = ${id!}`;
    expect(row!.record["location"]).toMatchObject({ geometryOrigin: "derived" });
    expect(dwd.requested.filter((u) => u.startsWith("https://maps.dwd.de/"))).toHaveLength(2);
  }, 60_000);

  it("de-dwd-alerts: a status zip whose every message is rejected keeps the last publication", async () => {
    const entries = unzipEntries(fixture("dwd-stat-mul.zip"), {
      maxEntries: 10,
      maxBytes: 1 << 20,
    });
    const dwd = harness("de-dwd-alerts", () => new Response(new Uint8Array(zip)));
    let zip = storedZip(entries);
    const T = "2026-10-08T22:30:00.000Z";
    expect((await dwd.poll(T)).error).toBeUndefined();
    const before = await dwd.live();
    expect(before).toHaveLength(2);

    // Every message reads, but none carries a usable issue time: each is rejected.
    const unusable = entries.map((e) => ({
      name: e.name,
      data: Buffer.from(
        e.data.toString("utf8").replace(/<sent>[^<]*<\/sent>/, "<sent>unknown</sent>"),
      ),
    }));
    zip = storedZip(unusable);
    const result = await dwd.poll(later(T, 300));
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/rejected/);
    expect(result.rejected).toBe(3);
    expect(await dwd.live()).toEqual(before);
  }, 60_000);

  it("de-dwd-alerts: one bad message beside messages that end by design keeps the last publication", async () => {
    const entries = unzipEntries(fixture("dwd-stat-mul.zip"), {
      maxEntries: 10,
      maxBytes: 1 << 20,
    });
    const dwd = harness("de-dwd-alerts", () => new Response(new Uint8Array(zip)));
    let zip = storedZip(entries);
    const T = "2026-10-08T22:45:00.000Z";
    expect((await dwd.poll(T)).error).toBeUndefined();
    const before = await dwd.live();
    expect(before).toHaveLength(2);

    // Two exercises (terminal) and one message without a usable issue time
    // (rejected): nothing was kept, so the poll says nothing about what is current.
    const [first, ...rest] = entries;
    const changed = (e: { name: string; data: Buffer }, from: RegExp, to: string) => ({
      name: e.name,
      data: Buffer.from(e.data.toString("utf8").replace(from, to)),
    });
    zip = storedZip([
      changed(first!, /<sent>[^<]*<\/sent>/, "<sent>unknown</sent>"),
      ...rest.map((e) => changed(e, /<status>[^<]*<\/status>/, "<status>Exercise</status>")),
    ]);
    const result = await dwd.poll(later(T, 300));
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/rejected/);
    expect(result.rejected).toBe(1);
    expect(await dwd.live()).toEqual(before);
  }, 60_000);

  /** The captured Datamart day of 2026-10-08; `today` replaces its day listing. The other days do not exist (404). */
  function ecccHarness(today: () => string) {
    const root = "https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/";
    const listing = (name: string) =>
      new Response(fixture(`eccc-datamart/${name}`), { headers: { "content-type": "text/html" } });
    return harness("ca-eccc-alerts", (url) => {
      if (url === root) return new Response(today(), { headers: { "content-type": "text/html" } });
      if (url === `${root}CWTO/`) return listing("office.txt");
      if (url === `${root}CWTO/18/`) return listing("hour-18.txt");
      if (url === `${root}CWTO/19/`) return listing("hour-19.txt");
      const file = url.slice(url.lastIndexOf("/") + 1);
      return file.endsWith(".cap") ? new Response(fixture(`eccc-datamart/${file}`)) : notFound();
    });
  }

  const ECCC_CHAIN = [
    "oc:situation:ca-eccc-alerts:urn:oid:2.49.0.1.124.1129882422.2026",
    "oc:situation:ca-eccc-alerts:urn:oid:2.49.0.1.124.1129882422.2026#2",
  ];

  it("ca-eccc-alerts: a Datamart walk whose every message expired publishes zero alerts", async () => {
    const eccc = ecccHarness(() => fixtureText("eccc-datamart/day.txt"));
    const T = "2026-10-08T22:00:00.000Z";
    expect((await eccc.poll(T)).error).toBeUndefined();
    // Three messages of one chain: the latest stands for the warning, one
    // situation per hazard it warns of.
    expect(await eccc.live()).toEqual(ECCC_CHAIN);
    // The days walked: the day before yesterday, yesterday and today.
    expect(eccc.requested.filter((u) => /\/cap\/\d{8}\/$/.test(u))).toEqual([
      "https://dd.weather.gc.ca/20261006/WXO-DD/alerts/cap/20261006/",
      "https://dd.weather.gc.ca/20261007/WXO-DD/alerts/cap/20261007/",
      "https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/",
    ]);

    // The chain's last hazard expires at 22:58:31.
    const quiet = await eccc.poll("2026-10-08T23:00:00.000Z");
    expect(quiet.error).toBeUndefined();
    expect(quiet.outcome).toBe("complete_empty");
    expect(quiet.deleted).toBe(2);
    expect(await eccc.live()).toEqual([]);
  }, 60_000);

  it("ca-eccc-alerts: a day listing answered by a page without links keeps the last publication", async () => {
    // Constructed: a maintenance page at HTTP 200 where the day's listing was.
    let today = fixtureText("eccc-datamart/day.txt");
    const eccc = ecccHarness(() => today);
    const T = "2026-10-08T22:00:00.000Z";
    expect((await eccc.poll(T)).error).toBeUndefined();
    expect(await eccc.live()).toEqual(ECCC_CHAIN);

    today = "<html><body><h1>Maintenance</h1><p>Back soon.</p></body></html>";
    const blank = await eccc.poll(later(T, 120));
    expect(blank.deleted ?? 0).toBe(0);
    expect(await eccc.live()).toEqual(ECCC_CHAIN);
  }, 60_000);

  it("eu-meteoalarm-alerts: served in the public scope, a NUTS3 area drawn through the aliases, its notice listed", async () => {
    const meteoalarm = harness("eu-meteoalarm-alerts", (url) => {
      if (url.endsWith("/feeds-switzerland")) {
        return new Response(fixture("meteoalarm-switzerland.json"));
      }
      if (url.endsWith("/feeds-france")) return new Response(fixture("meteoalarm-france.json"));
      if (url.includes("/api/v1/warnings/")) return new Response('{"warnings":[]}');
      return new Response(fixture("meteoalarm-geocodes.json"));
    });
    const T = "2026-10-08T15:00:00.000Z";
    expect((await meteoalarm.poll(T)).error).toBeUndefined();
    const stored = await meteoalarm.live();
    expect(stored.length).toBeGreaterThan(0);

    const ofMeteoAlarm = (body: Rec) =>
      (body["records"] as Rec[]).filter((r) =>
        String(r["id"]).startsWith("oc:situation:eu-meteoalarm-alerts:"),
      );
    const served = ofMeteoAlarm(await get("/situations?domain=hazards&kind=alert&limit=200"));
    expect(served.map((r) => String(r["id"])).sort()).toEqual(stored);
    const pyrenees = served.find((r) => String(r["id"]).endsWith(".082021"));
    expect(pyrenees?.["location"]).toMatchObject({ geometryOrigin: "derived" });

    const sources = (await get("/sources"))["sources"] as Rec[];
    expect(sources.find((s) => s["id"] === "eu-meteoalarm-alerts")).toMatchObject({
      restricted: false,
      format: "meteoalarm",
      notice:
        "Time delays between this website and the www.meteoalarm.org website are possible. For the most up-to-date awareness information as published by the participating National Meteorological and Hydrological Services, please refer to www.meteoalarm.org.",
    });
  }, 60_000);

  it("eu-meteoalarm-alerts: one country down costs that country only, once its held answer outlives two minutes", async () => {
    let franceDown = false;
    const meteoalarm = harness("eu-meteoalarm-alerts", (url) => {
      if (url.endsWith("/feeds-switzerland")) {
        return new Response(fixture("meteoalarm-switzerland.json"));
      }
      if (url.endsWith("/feeds-france")) {
        return franceDown
          ? new Response("upstream error", { status: 503 })
          : new Response(fixture("meteoalarm-france.json"));
      }
      if (url.includes("/api/v1/warnings/")) return new Response('{"warnings":[]}');
      return new Response(fixture("meteoalarm-geocodes.json"));
    });
    const country = (id: string) =>
      id.includes(".0.FR.") ? "FR" : id.includes(".CH.") ? "CH" : "?";
    /** The countries the operator reads at the clock. */
    const served = async () =>
      [
        ...new Set(
          ids(await get("/situations?domain=hazards&kind=alert&limit=200", OPERATOR))
            .filter((id) => id.startsWith("oc:situation:eu-meteoalarm-alerts:"))
            .map(country),
        ),
      ].sort();
    const T = "2026-10-08T15:00:00.000Z";
    expect((await meteoalarm.poll(T)).error).toBeUndefined();
    expect(await served()).toEqual(["CH", "FR"]);

    franceDown = true;
    // France's answer of T stands in while it is no older than 120 s.
    const held = await meteoalarm.poll(later(T, 120));
    expect(held.error).toBeUndefined();
    expect(await served()).toEqual(["CH", "FR"]);
    // Past that France contributes nothing; Switzerland still publishes.
    const gone = await meteoalarm.poll(later(T, 240));
    expect(gone.error).toBeUndefined();
    expect(gone.deleted).toBeGreaterThan(0);
    expect(await served()).toEqual(["CH"]);
    expect((await meteoalarm.poll(later(T, 360))).error).toBeUndefined();
    // France's last warnings, read at T + 120 s, expired at T + 300 s at the latest.
    clock = later(T, 400);
    expect(await served()).toEqual(["CH"]);
    expect((await meteoalarm.live()).every((id) => country(id) === "CH")).toBe(true);
  }, 60_000);

  it("eu-meteoalarm-alerts: every country down stands in per country, never with an older country's answer", async () => {
    let franceDown = false;
    let allDown = false;
    const meteoalarm = harness("eu-meteoalarm-alerts", (url) => {
      if (url.includes("/api/v1/warnings/") && allDown) {
        return new Response("upstream error", { status: 503 });
      }
      if (url.endsWith("/feeds-switzerland")) {
        return new Response(fixture("meteoalarm-switzerland.json"));
      }
      if (url.endsWith("/feeds-france")) {
        return franceDown
          ? new Response("upstream error", { status: 503 })
          : new Response(fixture("meteoalarm-france.json"));
      }
      if (url.includes("/api/v1/warnings/")) return new Response('{"warnings":[]}');
      return new Response(fixture("meteoalarm-geocodes.json"));
    });
    const countries = async () =>
      [
        ...new Set(
          (await meteoalarm.live()).map((id) =>
            id.includes(".0.FR.") ? "FR" : id.includes(".CH.") ? "CH" : "?",
          ),
        ),
      ].sort();
    const T = "2026-10-08T15:00:00.000Z";
    expect((await meteoalarm.poll(T)).error).toBeUndefined();
    expect(await countries()).toEqual(["CH", "FR"]);

    // France's answer of T stands in at T + 120 s.
    franceDown = true;
    expect((await meteoalarm.poll(later(T, 120))).error).toBeUndefined();
    expect(await countries()).toEqual(["CH", "FR"]);

    // Every country fails while the geocode file falls due, so the poll still
    // publishes: Switzerland's answer of T + 120 s stands in, France's of T is
    // too old to.
    allDown = true;
    delete meteoalarm.roles.lastFetchedAt["geocodes"];
    const outage = await meteoalarm.poll(later(T, 240));
    expect(outage.error).toBeUndefined();
    expect(await countries()).toEqual(["CH"]);
  }, 60_000);
});

describe("hazards fires, quakes and smoke through the pipeline", () => {
  it("nasa-firms-viirs-fires: the same file twice writes each pixel once, and the sweep ends them", async () => {
    const files: Record<string, string> = {
      "J2_VIIRS_C2_Global_24h.csv": "firms-viirs-n21.csv",
      "J1_VIIRS_C2_Global_24h.csv": "firms-viirs-n20.csv",
    };
    const firms = harness("nasa-firms-viirs-fires", (url) => {
      const name = files[url.slice(url.lastIndexOf("/") + 1)];
      return name === undefined ? notFound() : new Response(fixture(name));
    });
    const source = firms.feed.id;
    const counts = async () => {
      const [row] = await sql<{ series: number; history: number }[]>`
        SELECT (SELECT count(*)::int FROM conditions.observation_latest WHERE source_id = ${source}) AS series,
               (SELECT count(*)::int FROM conditions.observation o
                  JOIN conditions.observation_latest l USING (series_id)
                 WHERE l.source_id = ${source}) AS history`;
      return row!;
    };
    const T = "2026-10-07T03:00:00.000Z";
    expect((await firms.poll(T)).error).toBeUndefined();
    expect(await counts()).toEqual({ series: 7, history: 7 });
    expect((await firms.poll(later(T, 3600))).error).toBeUndefined();
    expect(await counts()).toEqual({ series: 7, history: 7 });

    const grid = await get(
      `/observations/grid?property=fire.frp&bbox=10,-20,20,0&cellDeg=1&since=2026-10-06T00:00:00Z`,
    );
    const cells = grid["cells"] as [number, number, number, number, number][];
    expect(cells.reduce((sum, cell) => sum + cell[2], 0)).toBe(7);
    expect(grid["sources"]).toEqual([source]);

    // 73 hours after the last acquisition every pixel has expired.
    const swept = await sweepRecords(sql, {
      registry,
      instanceId: "test.local",
      now: "2026-10-10T02:01:00.000Z",
      maxAgeSec: 3600,
      historyDays: 90,
    });
    expect(swept.transient).toBe(7);
    expect((await counts()).series).toBe(0);
  }, 60_000);

  it("usgs-quakes: the window read lists the month's quakes, and one gone from both roles is withdrawn", async () => {
    const month = JSON.parse(fixtureText("usgs-all-month.geojson")) as { features: Rec[] };
    let window = JSON.stringify(month);
    const usgs = harness("usgs-quakes", (url) =>
      url.endsWith("/all_day.geojson")
        ? new Response(fixture("usgs-all-day.geojson"))
        : new Response(window),
    );
    const T = "2026-10-09T01:20:00.000Z";
    const first = await usgs.poll(T);
    expect(first.error).toBeUndefined();
    // Every source record has a disposition, a quake in both roles counted once.
    expect(first.snapshot).toMatchObject({ accepted: 5 });

    const from = later(T, -30 * 86_400);
    const quakes = async () =>
      ids(
        await get(
          `/situations?domain=hazards&kind=natural_hazard&type=earthquake&from=${from}&limit=100`,
        ),
      )
        .map((id) => id.replace("oc:situation:usgs-quakes:", ""))
        .sort();
    expect(await quakes()).toEqual([
      "aka2026typggm",
      "us6000ty43",
      "us6000u0x4",
      "us6000u0xi",
      "uu80158811",
    ]);
    // Over in seconds: no current read lists them.
    expect(ids(await get("/situations?domain=hazards&type=earthquake"))).toEqual([]);

    window = JSON.stringify({
      ...month,
      features: month.features.filter((f) => f["id"] !== "us6000u0x4"),
    });
    const second = await usgs.poll(later(T, 900));
    expect(second.error).toBeUndefined();
    expect(second.deleted).toBe(1);
    expect(await quakes()).not.toContain("us6000u0x4");
  }, 60_000);

  it("us-nifc-fires: a fire in both layers is one record, and the poll's accounting holds", async () => {
    const nifc = harness("us-nifc-fires", (url) =>
      url.includes("WFIGS_Interagency_Perimeters_Current")
        ? new Response(fixture("nifc-perimeters.geojson"))
        : new Response(fixture("nifc-incidents.geojson")),
    );
    const result = await nifc.poll("2026-10-09T01:00:00.000Z");
    expect(result.error).toBeUndefined();
    const live = await nifc.live();
    // Three perimeters and three incident points: Aspen Acres is in both, the complex is skipped.
    expect(result.snapshot).toMatchObject({
      inputCount: 6,
      uniqueCount: 6,
      accepted: 4,
      terminal: 1,
    });
    expect(live).toHaveLength(4);
  }, 60_000);

  it("us-noaa-hms-smoke: a smoke polygon is current hours after its image sequence ended", async () => {
    const hms = harness("us-noaa-hms-smoke", () => new Response(fixture("hms-smoke.geojson")));
    // The sequences ended at 15:00 and 17:00.
    expect((await hms.poll("2026-09-30T19:50:00.000Z")).error).toBeUndefined();
    clock = "2026-09-30T20:00:00.000Z";
    const smoke = ids(await get("/situations?domain=hazards&kind=natural_hazard&type=smoke"));
    expect(smoke).toHaveLength(3);
    expect(smoke.every((id) => id.startsWith("oc:situation:us-noaa-hms-smoke:2026273-"))).toBe(
      true,
    );
  }, 60_000);
});

describe("hazards feeds in the catalogue", () => {
  it("holds the twelve feeds", () => {
    expect(HAZARDS.map((f) => f.id).sort()).toEqual([
      "ca-eccc-alerts",
      "de-dwd-alerts",
      "eu-effis-fires",
      "eu-meteoalarm-alerts",
      "gdacs-events",
      "nasa-eonet-events",
      "nasa-firms-modis-fires",
      "nasa-firms-viirs-fires",
      "us-nifc-fires",
      "us-noaa-hms-smoke",
      "us-nws-alerts",
      "usgs-quakes",
    ]);
  });

  it("credits the CC BY sources OC reshapes as modified", () => {
    const credit = (id: string) => HAZARDS.find((f) => f.id === id)?.attribution;
    expect(credit("gdacs-events")).toBe("GDACS, European Union (CC BY 4.0), modified");
    expect(credit("eu-effis-fires")).toMatch(/modified/);
  });
});
