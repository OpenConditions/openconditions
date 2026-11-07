import { readFileSync } from "node:fs";
import { geonetDraft, hazardsDomain } from "@openconditions/hazards";
import {
  type CatalogFeed,
  type LookupFn,
  readCatalogDir,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import { syncSources, writeSnapshot } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { sourcesOf } from "../api/sources.js";
import { acquireGeonet } from "../pipeline/geonet.js";
import { createRoleState, runSource } from "../pipeline/run.js";

const root = new URL("../../../../", import.meta.url).pathname;
const file = readCatalogDir(`${root}feeds`, [hazardsDomain], { otherDomains: "ignore" }).files.find(
  (f) => f.path.endsWith("/hazards/nz.jsonc"),
)!;
const feed = toCatalogFeed(file.feeds[0]!, {
  domain: file.domain,
  region: file.region,
  file: file.path,
  maintainers: file.maintainers,
}) as CatalogFeed;
const registry = productionRegistry();
const EVENT = "2026p837394";
const ID = `oc:situation:nz-geonet-quakes:${EVENT}`;
const capturedXml = readFileSync(
  `${root}packages/hazards/src/__tests__/fixtures/geonet/event.xml`,
  "utf8",
);
const captured = JSON.parse(
  readFileSync(`${root}packages/hazards/src/__tests__/fixtures/geonet/history.geojson`, "utf8"),
).features[0];
const feature = structuredClone(captured);
let xml = capturedXml;
let recent = true;
let noData = false;
let noDetail = false;
let outage = false;
let split = false;
let failSplit = false;
const calls: URL[] = [];
const lookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const collection = (features: unknown[]) => JSON.stringify({ type: "FeatureCollection", features });
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(input));
  calls.push(u);
  if (outage) return new Response(null, { status: 503 });
  if (u.hostname === "api.geonet.org.nz") {
    expect(new Headers(init?.headers).get("Accept")).toBe("application/vnd.geo+json;version=2");
    if (u.pathname === "/quake") return new Response(collection(recent ? [feature] : []));
    if (u.pathname.includes("/history/")) return new Response(collection([]));
    if (noData || noDetail) return new Response(null, { status: 204 });
    return new Response(collection([feature]));
  }
  expect(u.searchParams.has("eventtype")).toBe(false);
  expect(u.searchParams.has("includearrivals")).toBe(false);
  expect(u.searchParams.has("updateafter")).toBe(false);
  if (u.searchParams.has("eventid"))
    return noData ? new Response(null, { status: 204 }) : new Response(xml);
  const width =
    Date.parse(u.searchParams.get("endtime")!) - Date.parse(u.searchParams.get("starttime")!);
  if (split && width > 12 * 3600_000) return new Response(null, { status: 413 });
  if (failSplit && width < 13 * 3600_000) return new Response("broken XML");
  const origin = xml.match(/<preferredOriginID>([^<]+)/)?.[1];
  const preferred = origin ? xml.slice(xml.indexOf(`<origin publicID="${origin}"`)) : "";
  const eventTime = Date.parse(preferred.match(/<time><value>([^<]+)/)?.[1] ?? "");
  const inWindow =
    eventTime >= Date.parse(u.searchParams.get("starttime")!) &&
    eventTime <= Date.parse(u.searchParams.get("endtime")!);
  return noData || !inWindow ? new Response(null, { status: 204 }) : new Response(xml);
}) as typeof fetch;
let db: TestDatabase;
let now = "2026-11-07T12:00:00Z";
const poll = () =>
  runSource(feed, {
    sql: db.sql,
    fetch: fakeFetch,
    lookup,
    now: () => now,
    model: { registry, instanceId: "geonet-test" },
    geonetQualification: "contract-test",
    roles: createRoleState(),
  });
const kept = async () =>
  (
    await db.sql<
      { record: Record<string, unknown>; tombstone_reason: string | null }[]
    >`SELECT record, tombstone_reason FROM conditions.situation WHERE id = ${ID}`
  )[0]!;
const cursor = async () =>
  (
    await db.sql<
      { t: string }[]
    >`SELECT covered_until::text AS t FROM conditions.geonet_coverage WHERE source_id = ${feed.id}`
  )[0]?.t;

beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [
    { ...feed, restricted: false },
    {
      ...feed,
      id: "usgs-quakes",
      format: "usgs",
      license: "LicenseRef-US-Gov-Public-Domain",
      restricted: false,
    },
  ]);
}, 180_000);
afterAll(async () => {
  await db?.close();
}, 30_000);

describe("GeoNet bounded worker and durable publication lifecycle", () => {
  it("enforces the runtime gate as well as the disabled catalogue", async () => {
    expect(feed.disabled).toBeDefined();
    await expect(
      runSource(feed, { sql: db.sql, fetch: fakeFetch, now: () => now }),
    ).rejects.toThrow("qualification");
    expect(sourcesOf({ sources: [feed] })).toEqual([]);
  });
  it("publishes precise canonical values and exposes credits through API/export", async () => {
    expect((await poll()).error).toBeUndefined();
    expect((await kept()).record).toMatchObject({
      id: ID,
      externalIds: [{ scheme: "geonet:event", id: EVENT }],
      details: {
        magnitude: { value: 2.1407037605271118, scale: "MLv" },
        depth: { value: 3969.5246219635, unit: "m" },
        reviewed: true,
      },
      provenance: { sourceFormat: "geonet" },
      freshness: { fetchedAt: now },
    });
    const app = Fastify();
    registerScope(app, undefined);
    registerApiRoutes(app, db.sql, {
      registry,
      now: () => new Date(now),
      catalog: { sources: [{ ...feed, disabled: undefined }] },
    });
    await app.ready();
    try {
      const q = `?from=2026-11-06T00:00:00Z&to=${now}&domain=hazards`;
      const res = await app.inject(`/situations${q}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().records).toHaveLength(1);
      expect(res.json().records[0]).toMatchObject({
        id: ID,
        details: { magnitude: { value: 2.1407037605271118, scale: "MLv" } },
        provenance: {
          attribution: {
            license: "LicenseRef-CC-BY-3.0-NZ",
            licenseUrl: "https://creativecommons.org/licenses/by/3.0/nz/",
          },
        },
      });
      expect(JSON.stringify(res.json())).toContain("10.21420/0S8P-TZ38");
      const geo = await app.inject(`/situations.geojson${q}`);
      expect(geo.statusCode).toBe(200);
      expect(JSON.stringify(geo.json())).toContain(ID);
      expect(JSON.stringify(geo.json())).toContain("CC-BY-3.0-NZ");
      const sourceResponse = await app.inject("/sources");
      expect(sourceResponse.statusCode).toBe(200);
      expect(JSON.stringify(sourceResponse.json())).toContain("nz-geonet-quakes");
      const qualified = { ...feed };
      delete qualified.disabled;
      const source = sourcesOf({ sources: [qualified] })[0]!;
      expect(source).toMatchObject({ id: "nz-geonet-quakes", license: "LicenseRef-CC-BY-3.0-NZ" });
      expect(source.attribution).toContain("NHC");
      expect(source.attribution).toContain("NEMA");
      expect(source.attribution).toContain("Modified:");
    } finally {
      await app.close();
    }
  });
  it("keeps GeoNet and USGS separate at an identical epicentre and enforces upstream public rights", async () => {
    const draft = geonetDraft(feed, feature, undefined, now)!;
    draft["id"] = "oc:situation:usgs-quakes:synthetic-same-epicentre";
    draft["externalIds"] = [{ scheme: "usgs:event", id: "synthetic-same-epicentre" }];
    draft["provenance"] = {
      ...(draft["provenance"] as Record<string, unknown>),
      sourceId: "usgs-quakes",
      sourceFormat: "usgs",
      recordId: "synthetic-same-epicentre",
      attribution: { provider: "USGS", license: "LicenseRef-US-Gov-Public-Domain" },
    };
    const summary = await writeSnapshot(
      db.sql,
      "usgs-quakes",
      { situations: [draft] },
      { registry, instanceId: "geonet-test", now, complete: true },
    );
    expect(summary.rejected).toEqual([]);
    const app = Fastify();
    registerScope(app, undefined);
    registerApiRoutes(app, db.sql, { registry, now: () => new Date(now) });
    const q = "/situations?domain=hazards&from=2026-11-06T00:00:00Z&to=2026-11-07T12:00:00Z";
    try {
      const both = await app.inject(q);
      expect(
        both
          .json()
          .records.map((r: Record<string, unknown>) => r["id"])
          .sort(),
      ).toEqual([ID, "oc:situation:usgs-quakes:synthetic-same-epicentre"].sort());
      await db.sql`UPDATE conditions.situation SET record = jsonb_set(record, '{provenance,upstream}', '[{"publisher":"Synthetic restricted upstream","license":"NOASSERTION"}]'::jsonb) WHERE id = ${ID}`;
      const filtered = await app.inject(q);
      expect(filtered.json().records.map((r: Record<string, unknown>) => r["id"])).toEqual([
        "oc:situation:usgs-quakes:synthetic-same-epicentre",
      ]);
      const geo = await app.inject(q.replace("/situations?", "/situations.geojson?"));
      expect(JSON.stringify(geo.json())).not.toContain(ID);
    } finally {
      await db.sql`UPDATE conditions.situation SET record = record #- '{provenance,upstream}' WHERE id = ${ID}`;
      await db.sql`DELETE FROM conditions.situation WHERE source_id = 'usgs-quakes'`;
      await app.close();
    }
  });
  it("keeps stable identity through MMI 3 to 2 and a revision crossing a window boundary", async () => {
    feature.properties.mmi = 2;
    feature.properties.depth = 10;
    feature.properties.time = "2026-11-05T11:59:59Z";
    // 204 enrichment has no invented typed scale; API depth is kilometres.
    xml = capturedXml
      .replace("2026-11-06T20:03:41.541356Z", "2026-11-05T11:59:59Z")
      .replace("3969.5246219635", "10000");
    now = "2026-11-07T12:10:00Z";
    expect((await poll()).error).toBeUndefined();
    expect((await kept()).record).toMatchObject({
      id: ID,
      extras: { geonetLocalityMmi: 2 },
      details: { depth: { value: 10000, unit: "m" } },
      validity: { start: "2026-11-05T11:59:59Z" },
    });
    expect(calls.some((u) => u.searchParams.has("updatedafter"))).toBe(true);
  });
  it("retains cap rollover and 204 across process role-state restarts", async () => {
    recent = false;
    noData = true;
    now = "2026-11-07T12:20:00Z";
    expect((await poll()).error).toBeUndefined();
    expect((await kept()).tombstone_reason).toBeNull();
    expect((await kept()).record).toHaveProperty("freshness.fetchedAt", "2026-11-07T12:10:00Z");
  });
  it("splits 413; incomplete windows/outages do not advance durable coverage or publication", async () => {
    noData = false;
    split = true;
    now = "2026-11-07T12:30:00Z";
    expect((await poll()).error).toBeUndefined();
    const before = await cursor();
    const record = (await kept()).record;
    failSplit = true;
    now = "2026-11-07T12:40:00Z";
    expect((await poll()).error).toBeDefined();
    expect(await cursor()).toBe(before);
    expect((await kept()).record).toEqual(record);
    failSplit = false;
    outage = true;
    expect((await poll()).error).toContain("503");
    expect(await cursor()).toBe(before);
    outage = false;
    expect((await poll()).error).toBeUndefined();
    expect(await cursor()).not.toBe(before);
  });
  it("withdraws an explicitly reclassified event even when the API detail is absent", async () => {
    xml = xml.replace("<type>earthquake</type>", "<type>quarry blast</type>");
    noDetail = true;
    now = "2026-11-07T12:45:00Z";
    expect((await poll()).error).toBeUndefined();
    expect((await kept()).tombstone_reason).toBe("withdrawn");
    xml = xml.replace("<type>quarry blast</type>", "<type>earthquake</type>");
    noDetail = false;
    recent = true;
    now = "2026-11-07T12:46:00Z";
    expect((await poll()).error).toBeUndefined();
    expect((await kept()).tombstone_reason).toBeNull();
  });
  it("explicit deleted immediately withdraws; recovery and expiry are separate dispositions", async () => {
    feature.properties.quality = "deleted";
    now = "2026-11-07T12:50:00Z";
    expect((await poll()).error).toBeUndefined();
    expect((await kept()).tombstone_reason).toBe("withdrawn");
    feature.properties.quality = "best";
    recent = true;
    now = "2026-11-07T13:00:00Z";
    expect((await poll()).error).toBeUndefined();
    expect((await kept()).tombstone_reason).toBeNull();
    noData = true;
    recent = false;
    now = "2026-11-10T00:00:00Z";
    expect((await poll()).error).toBeUndefined();
    expect((await kept()).tombstone_reason).toBe("expired");
    const app = Fastify();
    registerScope(app, undefined);
    registerApiRoutes(app, db.sql, { registry, now: () => new Date(now) });
    try {
      const response = await app.inject(
        "/situations?domain=hazards&from=2026-11-04T00:00:00Z&to=2026-11-10T00:00:00Z",
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().records).toEqual([]);
    } finally {
      await app.close();
    }
  });
  it("cancels bounded acquisition", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireGeonet(feed, fakeFetch, now, [], undefined, controller.signal),
    ).rejects.toThrow();
  });
});
