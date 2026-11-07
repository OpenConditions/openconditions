import { readFileSync } from "node:fs";
import { readCatalogDir, toCatalogFeed, unzipEntries } from "@openconditions/ingest-framework";
import { buildRegistry } from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
} from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import { weatherDomain } from "@openconditions/weather";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { buildZip } from "./helpers/zip.js";

// Only this bounded fixture harness bypasses the production load-qualification gate.
let qualified = false;
vi.mock("../domains.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../domains.js")>();
  return {
    ...original,
    formatOf: (src: Parameters<typeof original.formatOf>[0]) => {
      const format = original.formatOf(src);
      return src.format === "dwd-cdc-10min" && qualified
        ? { ...format, acquisitionBlockedReason: undefined }
        : format;
    },
  };
});
const registry = buildRegistry(productionModules);
const root = new URL("../../../../packages/weather/src/__tests__/fixtures/dwd/", import.meta.url);
const fixture = (file: string) => readFileSync(new URL(file, root));
const file = readCatalogDir(
  new URL("../../../../feeds/", import.meta.url).pathname,
  [weatherDomain],
  { otherDomains: "ignore" },
).files.find((f) => f.region === "de")!;
const feed = toCatalogFeed(file.feeds[0]!, {
  domain: file.domain,
  region: file.region,
  file: file.path,
  maintainers: file.maintainers,
});
delete feed.disabled;
// Compress hourly cadence to one minute only in this bounded fixture clock.
for (const [role, endpoint] of Object.entries(feed.endpoints)) {
  if (!role.endsWith("_stations")) endpoint.cadenceSec = 60;
  if (endpoint.each) endpoint.each.revalidateSec = 60;
}
let db: TestDatabase;
let app: ReturnType<typeof Fastify>;
let now = "2026-11-07T23:05:00Z";
let roles = createRoleState();
const calls: string[] = [];
let correction = false;
let failing = false;
let missingWind = false;
let restricted = false;
const fetch = (async (input: unknown) => {
  const url = String(input);
  calls.push(url);
  if (failing) return new Response("unavailable", { status: 503 });
  const role = url.includes("air_temperature")
    ? "tu"
    : url.includes("extreme_wind")
      ? "fx"
      : url.includes("precipitation")
        ? "rr"
        : "ff";
  if (url.endsWith("/")) {
    const id = role === "tu" || role === "rr" ? "00044" : "00011";
    const code = { tu: "TU", rr: "nieder", ff: "wind", fx: "extrema_wind" }[role];
    return new Response(
      `<a href="10minutenwerte_${code}_${id}_now.zip">file</a> 07-Nov-2026 22:50:00 100\n`,
    );
  }
  if (url.endsWith(".txt")) {
    const bytes = fixture(`${role}-stations.txt`);
    return new Response(
      restricted
        ? Buffer.from(
            bytes.toString("latin1").replace(/^(00044[^\n]*?)Frei/m, "$1Gesperrt"),
            "latin1",
          )
        : bytes,
    );
  }
  let body: Buffer = fixture(`${role}.zip`);
  if (correction && role === "tu") {
    const e = unzipEntries(body, { maxEntries: 8, maxBytes: 2_000_000 })[0]!;
    const rows = e.data.toString("latin1").trim().split(/\r?\n/);
    const header = rows[0]!.split(";").map((s) => s.trim());
    const last = rows[rows.length - 1]!.split(";");
    last[header.indexOf("TT_10")] = "7.7";
    rows[rows.length - 1] = last.join(";");
    body = buildZip([{ name: e.name, data: rows.join("\n") }]);
  }
  if (missingWind && (role === "ff" || role === "fx")) {
    const e = unzipEntries(body, { maxEntries: 8, maxBytes: 2_000_000 })[0]!;
    body = buildZip([
      {
        name: e.name.replace("00011", "99999"),
        data: e.data.toString("latin1").replace(/\b11;/g, "99999;"),
      },
    ]);
  }
  return new Response(new Uint8Array(body));
}) as typeof globalThis.fetch;
const tick = () =>
  runSource(feed, {
    sql: db.sql,
    fetch,
    roles,
    now: () => now,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    model: { registry, instanceId: "test.local" },
  });
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureObservationPartitions(db.sql, {
    classes: retentionClasses(registry),
    now: new Date(now),
  });
  await syncSources(db.sql, [feed]);
  app = Fastify();
  registerScope(app, "test-token");
  registerApiRoutes(app, db.sql, {
    registry,
    now: () => new Date(now),
    catalog: { sources: [feed] },
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});

test("worker qualification gate prevents requests even for a locally enabled catalogue", async () => {
  const result = await tick();
  expect(result.error).toMatch(/not qualified/);
  expect(calls).toEqual([]);
});
test("real worker publishes public station channels, canonical units and credit, retains failed polls and same-clock corrections", async () => {
  qualified = true;
  const first = await tick();
  expect(first.error).toBeUndefined();
  expect(first.count).toBe(9);
  const features = await app.inject({ url: "/features?kind=weather_station&expand=components" });
  expect(features.statusCode).toBe(200);
  expect(features.body).toContain("Großenkneten");
  expect(features.body).toContain("TT_10");
  expect(features.body).toContain("Quelle: Deutscher Wetterdienst");
  const sources = await app.inject({ url: "/sources" });
  expect(sources.statusCode).toBe(200);
  expect(sources.body).toContain(feed.id);
  expect(sources.body).toContain("CC-BY-4.0");
  const before =
    await db.sql`SELECT property,series_id,effective_from,reading FROM conditions.observation_latest WHERE source_id=${feed.id}`;
  expect(before.length).toBeGreaterThan(0);
  correction = true;
  const metadataRequests = calls.filter((url) => url.endsWith(".txt")).length;
  now = "2026-11-07T23:06:00Z";
  const corrected = await tick();
  expect(calls.filter((url) => url.endsWith(".txt"))).toHaveLength(metadataRequests);
  expect(corrected.error).toBeUndefined();
  // Same source clock remains the observation identity while its corrected result updates storage.
  const rows =
    await db.sql`SELECT property,series_id,effective_from,reading FROM conditions.observation_latest WHERE source_id=${feed.id} AND property='weather.air_temperature'`;
  expect(rows[0]?.reading.result.value).toBe(7.7);
  const previous = before.find((r) => r.property === "weather.air_temperature");
  expect(rows[0]?.series_id).toBe(previous?.series_id);
  expect(rows[0]?.effective_from).toEqual(previous?.effective_from);
  const latest = await app.inject({ url: "/observations/latest?property=weather.air_temperature" });
  expect(latest.statusCode).toBe(200);
  expect(latest.body).toContain("7.7");
  expect(latest.body).toContain("Cel");
  missingWind = true;
  roles = createRoleState();
  now = "2026-11-07T23:07:00Z";
  expect((await tick()).error).toBeUndefined();
  expect(
    (
      await db.sql`SELECT id FROM conditions.feature WHERE source_id=${feed.id} AND tombstoned_at IS NULL`
    ).length,
  ).toBe(2);
  missingWind = false;
  restricted = true;
  roles = createRoleState();
  now = "2026-11-07T23:08:00Z";
  expect((await tick()).error).toBeUndefined();
  const publicFeatures = await app.inject({ url: "/features?kind=weather_station" });
  expect(publicFeatures.body).not.toContain("Großenkneten");
  const publicReadings = await app.inject({
    url: "/observations/latest?property=weather.air_temperature",
  });
  expect(publicReadings.body).not.toContain("7.7");
  const featuresBefore =
    await db.sql`SELECT id,tombstoned_at FROM conditions.feature WHERE source_id=${feed.id}`;
  failing = true;
  now = "2026-11-08T01:05:00Z";
  await tick();
  expect(
    await db.sql`SELECT id,tombstoned_at FROM conditions.feature WHERE source_id=${feed.id}`,
  ).toEqual(featuresBefore);
});
