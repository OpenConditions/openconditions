import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
} from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import { weatherDomain } from "@openconditions/weather";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createParseProcess } from "../pipeline/parse-process.js";
import { attributionStamp, publishFeatures } from "../pipeline/publish.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";
import { registry } from "./helpers/situations.js";

const dir = join(import.meta.dirname, "../../../../packages/weather/src/__tests__/fixtures/smhi");
const feed = structuredClone(repoFeed("se-smhi-weather"));
const roles = createRoleState();
const parser = createParseProcess({ minBytes: 0 });
let db: TestDatabase;
let app: FastifyInstance;
let clock = "2026-11-08T00:30:00Z";
let failure = "stale";
let notModified = false;
let revision = false;
let shrink = false;
let wholeAbsent = false;
let invalidName = false;
let missing = false;
const requested: { url: string; validator: string | null }[] = [];
const upstream = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const parameter = /parameter\/(\d+)/.exec(u.pathname)![1]!;
  const role = u.pathname.endsWith("data.json") ? "status" : "sites";
  requested.push({ url: String(url), validator: new Headers(init?.headers).get("if-none-match") });
  expect(u.searchParams.get("measuringStations")).toBe("core");
  if (failure === parameter) return new Response("bad", { status: 503 });
  if (failure === "malformed" && parameter === "7") return new Response("{}");
  if (notModified)
    return new Response(null, {
      status: 304,
      headers: {
        "cache-control": "max-age=600",
        "last-modified": new Date(httpClock).toUTCString(),
      },
    });
  const raw = readFileSync(join(dir, `${parameter}-${role}.json.raw`));
  const doc = JSON.parse(raw.toString());
  if (revision && role === "status" && parameter === "1") doc.station[0].value[0].value = "9.7";
  if (invalidName) {
    if (role === "sites") for (const station of doc.station) station.name = "";
    for (const station of doc.station) if (station.key === "188790") station.longitude += 0.01;
  }
  if (missing && role === "status" && parameter === "1") doc.station[0].value = null;
  if (shrink && role === "sites" && parameter === "1") doc.station = [];
  if (wholeAbsent)
    doc.station = doc.station.filter((station: { key: string }) => station.key !== "188790");
  return new Response(JSON.stringify(doc), {
    headers: {
      etag: invalidName
        ? '"invalid-candidate"'
        : missing
          ? '"missing-candidate"'
          : revision
            ? '"revision"'
            : '"captured"',
      "cache-control": role === "status" ? "max-age=600" : "max-age=60",
      ...(failure === "stale" ? { age: "1866", date: "Mon, 09 Nov 2026 14:23:38 GMT" } : {}),
    },
  });
}) as typeof fetch;
let httpClock = Date.now();
const poll = () => {
  // Synthetic HTTP spacing is independent of the immutable fixture measurement clock.
  httpClock += 3600000;
  return runSource(feed, {
    sql: db.sql,
    fetch: upstream,
    roles,
    parseProcess: parser,
    now: () => clock,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    model: { registry, instanceId: "test.local" },
  });
};
const get = async (url: string) => {
  const r = await app.inject({ url });
  expect(r.statusCode).toBe(200);
  return r.json();
};

beforeAll(async () => {
  vi.spyOn(Date, "now").mockImplementation(() => httpClock);
  db = await createTestDatabase();
  await ensureObservationPartitions(db.sql, {
    classes: retentionClasses(registry),
    now: new Date(clock),
  });
  await syncSources(db.sql, [feed]);
  app = Fastify();
  registerScope(app, "smhi-test-token");
  registerApiRoutes(app, db.sql, {
    registry,
    now: () => new Date(clock),
    catalog: { sources: [...REPO_CATALOG.sources, feed] },
  });
  await app.ready();
}, 180000);
afterAll(async () => {
  await parser.close();
  await app?.close();
  await db?.close();
  vi.restoreAllMocks();
});

test("real worker/API publication, correction, acquisition rollback, membership retention and expiry", async () => {
  expect(feed.disabled).toBeUndefined();
  const first = await poll();
  expect(first.error).toBeUndefined();
  expect(requested).toHaveLength(16);
  const sources = await get("/sources");
  expect(sources.sources.find((s: { id: string }) => s.id === feed.id)).toMatchObject({
    country: "SE",
    license: "CC-BY-4.0",
    attribution: "Source: SMHI; normalized by OpenConditions; CC BY 4.0",
    coverage: { countries: ["SE"] },
  });
  const features = await get(`/features?source=${feed.id}&expand=components,latest&limit=1000`);
  expect(features.records.length).toBeGreaterThan(180);
  const abisko = features.records.find((r: { id: string }) => r.id.endsWith(":188790"));
  expect(abisko).toMatchObject({
    location: { admin: { country: "SE" } },
    extras: { owner: "Polarforskningssekretariatet", measuringStations: "CORE" },
  });
  expect(abisko.components.some((c: { key: string }) => c.key === "1")).toBe(true);
  const readings = await get(`/observations/latest?source=${feed.id}&limit=1000`);
  expect(readings.records.length).toBeGreaterThan(0);
  expect(readings.records[0]).toMatchObject({
    validUntil: "2026-11-08T01:00:00Z",
    provenance: {
      attribution: {
        provider: feed.attribution,
        license: "CC-BY-4.0",
        licenseUrl: feed.licenseUrl,
      },
    },
  });
  const geo = await get(`/features.geojson?source=${feed.id}&limit=1000`);
  expect(geo.features.length).toBeGreaterThan(180);
  const before =
    await db.sql`SELECT series_id, effective_from, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`;
  failure = "";
  clock = "2026-11-08T00:40:00Z";
  revision = true;
  requested.length = 0;
  expect((await poll()).error).toBeUndefined();
  expect(requested).toHaveLength(8);
  expect(requested.every((r) => r.validator === '"captured"')).toBe(true);
  const corrected =
    await db.sql`SELECT series_id, effective_from, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`;
  expect(corrected.map((r) => r.series_id)).toEqual(before.map((r) => r.series_id));
  const [abiskoReading] =
    await db.sql`SELECT series_id, effective_from, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} AND feature_id = ${`oc:feature:${feed.id}:188790`} AND component_key = '1'`;
  expect(abiskoReading!.reading.result).toEqual({ type: "quantity", unit: "Cel", value: 9.7 });
  expect(abiskoReading!.effective_from.toISOString()).toBe("2026-11-08T00:00:00.000Z");
  expect(before.find((r) => r.series_id === abiskoReading!.series_id)!.reading.result.value).toBe(
    3.7,
  );
  clock = "2026-11-08T00:50:00Z";
  const stored = async () => ({
    features:
      await db.sql`SELECT * FROM conditions.feature WHERE source_id = ${feed.id} ORDER BY id`,
    latest:
      await db.sql`SELECT * FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`,
    publicFeatures: await get(`/features?source=${feed.id}&expand=components,latest&limit=1000`),
    publicReadings: await get(`/observations/latest?source=${feed.id}&limit=1000`),
  });
  delete roles.lastFetchedAt.sites;
  delete roles.lastFetchedAt.status;
  const baseline = await stored();
  const roleSnapshot = () =>
    JSON.stringify(roles, (_key, value) => (value instanceof Map ? [...value] : value));
  const previousRoles = roleSnapshot();
  failure = "stale";
  invalidName = true;
  // HTTP-stale candidates reach native validation; invalid source content still rolls back.
  expect((await poll()).error).toMatch(/SMHI.*reject/);
  expect(await stored()).toEqual(baseline);
  expect(roleSnapshot()).toEqual(previousRoles);
  failure = "";
  invalidName = true;
  expect((await poll()).error).toMatch(/SMHI.*reject/);
  expect(await stored()).toEqual(baseline);
  expect(roleSnapshot()).toEqual(previousRoles);
  invalidName = false;
  const payloads = Object.fromEntries(
    ["sites", "status"].map((role) => [
      role,
      ["1", "39", "6", "12", "3", "4", "21", "7"].map((key) =>
        readFileSync(join(dir, `${key}-${role}.json.raw`)),
      ),
    ]),
  );
  const parsed = weatherDomain.formats["smhi-metobs"]!.parse(feed, payloads, {
    fetchedAt: clock,
    cadenceSec: 600,
    reference: {},
  });
  const [attempt] =
    await db.sql`SELECT id FROM conditions.source_poll_attempt WHERE source = ${feed.id} ORDER BY id DESC LIMIT 1`;
  for (const invalid of ["component", "observation"]) {
    const stamp = attributionStamp(feed, new Date(clock));
    const output = {
      features: structuredClone(parsed.features).map(stamp),
      observations: structuredClone(parsed.observations).map(stamp),
      offers: [],
    };
    if (invalid === "component")
      (output.features[0]!["components"] as { kind: string }[])[0]!.kind = "";
    else output.observations[0]!["result"] = { type: "quantity", unit: "invalid", value: 1 };
    await expect(
      publishFeatures(db.sql, feed, {
        output,
        atomicCoherence: true,
        rejected: 0,
        poll: { id: Number(attempt!.id), at: clock },
        durationMs: 0,
        now: clock,
        model: { registry, instanceId: "test.local" },
      }),
    ).rejects.toThrow(/SMHI.*reject/);
    expect(await stored()).toEqual(baseline);
  }
  revision = false;
  missing = true;
  feed.license = "ODbL-1.0";
  await syncSources(db.sql, [feed]);
  expect((await poll()).error).toMatch(/SMHI.*rights/);
  expect(requested.slice(-16).every((r) => r.validator !== '"invalid-candidate"')).toBe(true);
  expect(await stored()).toEqual(baseline);
  expect(roleSnapshot()).toEqual(previousRoles);
  // A status-only transition must also refuse an inconsistent publication.
  roles.lastFetchedAt.sites = Date.parse(clock);
  const statusRoles = roleSnapshot();
  expect((await poll()).error).toMatch(/SMHI.*rights/);
  expect(await stored()).toEqual(baseline);
  expect(roleSnapshot()).toEqual(statusRoles);
  expect(requested.slice(-8).every((r) => r.validator !== '"missing-candidate"')).toBe(true);
  // A complete restatement can coherently change rights, then recover.
  missing = false;
  delete roles.lastFetchedAt.sites;
  expect((await poll()).error).toBeUndefined();
  expect((await get(`/observations/latest?source=${feed.id}&limit=1000`)).records).toHaveLength(0);
  expect(
    (await get(`/features?source=${feed.id}&expand=components,latest&limit=1000`)).records,
  ).toHaveLength(0);
  feed.license = "CC-BY-4.0";
  await syncSources(db.sql, [feed]);
  delete roles.lastFetchedAt.sites;
  delete roles.lastFetchedAt.status;
  expect((await poll()).error).toBeUndefined();
  expect(
    (await get(`/observations/latest?source=${feed.id}&limit=1000`)).records.length,
  ).toBeGreaterThan(0);
  delete roles.lastFetchedAt.status;
  const held = { ...roles.payloads };
  const fetchedAt = { ...roles.lastFetchedAt };
  clock = "2026-11-08T00:50:00Z";
  failure = "7";
  expect((await poll()).error).toBeDefined();
  expect(roles.payloads).toEqual(held);
  expect(roles.lastFetchedAt).toEqual(fetchedAt);
  failure = "malformed";
  expect((await poll()).error).toBeDefined();
  expect(roles.payloads).toEqual(held);
  failure = "";
  shrink = true;
  delete roles.lastFetchedAt.sites;
  expect((await poll()).error).toMatch(/membership shrink/);
  expect(
    (await get(`/features?source=${feed.id}&expand=components&limit=1000`)).records,
  ).toHaveLength(features.records.length);
  // Rights transitions cannot publish metadata missing a retained channel either.
  const oldLicense = feed.license;
  feed.license = "ODbL-1.0";
  expect((await poll()).error).toMatch(/membership shrink/);
  shrink = false;
  wholeAbsent = true;
  expect((await poll()).error).toMatch(/membership shrink/);
  feed.license = oldLicense;
  expect((await poll()).error).toMatch(/membership shrink/);
  wholeAbsent = false;
  expect((await poll()).error).toBeUndefined();
  // A conditional 304 and byte-identical 200 keep the original source expiry.
  for (const conditional of [true, false]) {
    notModified = conditional;
    delete roles.lastFetchedAt.status;
    const repeat = await poll();
    expect(repeat.error).toBeUndefined();
    const live = await get(`/observations/latest?source=${feed.id}&limit=1000`);
    expect(live.records.length).toBeGreaterThan(0);
    expect(
      live.records.every((r: { validUntil: string }) => r.validUntil === "2026-11-08T01:00:00Z"),
    ).toBe(true);
  }
  const lastGoodReadings =
    await db.sql`SELECT series_id, effective_from, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`;
  clock = "2026-11-08T01:01:00Z";
  for (const conditional of [true, false]) {
    notModified = conditional;
    delete roles.lastFetchedAt.status;
    await poll();
    expect((await get(`/observations/latest?source=${feed.id}&limit=1000`)).records).toHaveLength(
      0,
    );
  }
  notModified = false;
  expect(
    await db.sql`SELECT series_id, effective_from, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`,
  ).toEqual(lastGoodReadings);
  expect((await get(`/observations/latest?source=${feed.id}&limit=1000`)).records).toHaveLength(0);
  clock = "2026-11-08T00:50:00Z";
  expect(
    (await get(`/observations/latest?source=${feed.id}&limit=1000`)).records.length,
  ).toBeGreaterThan(0);
  // A captured upstream restriction is independent of the first-party CC BY grant.
  await db.sql`UPDATE conditions.observation_latest SET template = jsonb_set(template, '{provenance,upstream}', '[{"publisher":"Restricted upstream","license":"ODbL-1.0"}]'::jsonb) WHERE source_id = ${feed.id}`;
  expect((await get(`/observations/latest?source=${feed.id}&limit=1000`)).records).toHaveLength(0);
  await db.sql`UPDATE conditions.feature SET record = jsonb_set(record, '{provenance,upstream}', '[{"publisher":"Restricted upstream","license":"ODbL-1.0"}]'::jsonb) WHERE source_id = ${feed.id}`;
  expect(
    (await get(`/features?source=${feed.id}&expand=components,latest&limit=1000`)).records,
  ).toHaveLength(0);
  expect((await get(`/features.geojson?source=${feed.id}&limit=1000`)).features).toHaveLength(0);
}, 180000);
