import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
} from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";
import { registry } from "./helpers/situations.js";

const dir = join(import.meta.dirname, "../../../../packages/weather/src/__tests__/fixtures/smhi");
const feed = structuredClone(repoFeed("se-smhi-weather"));
const roles = createRoleState();
let db: TestDatabase;
let app: FastifyInstance;
let clock = "2026-11-08T00:30:00Z";
let failure = "";
let revision = false;
let shrink = false;
const requested: { url: string; validator: string | null }[] = [];
const upstream = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const parameter = /parameter\/(\d+)/.exec(u.pathname)![1]!;
  const role = u.pathname.endsWith("data.json") ? "status" : "sites";
  requested.push({ url: String(url), validator: new Headers(init?.headers).get("if-none-match") });
  expect(u.searchParams.get("measuringStations")).toBe("core");
  if (failure === parameter) return new Response("bad", { status: 503 });
  if (failure === "malformed" && parameter === "7") return new Response("{}");
  const raw = readFileSync(join(dir, `${parameter}-${role}.json.raw`));
  const doc = JSON.parse(raw.toString());
  if (revision && role === "status" && parameter === "1") doc.station[0].value[0].value = "9.7";
  if (shrink && role === "sites" && parameter === "1") doc.station = [];
  return new Response(JSON.stringify(doc), {
    headers: {
      etag: revision ? '"revision"' : '"captured"',
      "cache-control": role === "status" ? "max-age=600" : "max-age=60",
    },
  });
}) as typeof fetch;
const poll = () =>
  runSource(feed, {
    sql: db.sql,
    fetch: upstream,
    roles,
    now: () => clock,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    model: { registry, instanceId: "test.local" },
  });
const get = async (url: string) => {
  const r = await app.inject({ url });
  expect(r.statusCode).toBe(200);
  return r.json();
};

beforeAll(async () => {
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
  await app?.close();
  await db?.close();
});

test("real worker/API publication, correction, acquisition rollback, membership retention and expiry", async () => {
  expect((await poll()).error).toMatch(/qualification gate/);
  expect(requested).toHaveLength(0);
  // Fixture qualification explicitly opts in; the authored feed remains disabled.
  delete feed.disabled;
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
  feed.license = oldLicense;
  clock = "2026-11-08T01:01:00Z";
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
