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
// These local bytes do not consume provider capacity; pacing has separate framework tests.
delete feed.requestLimits;
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
const validators: (string | null)[] = [];
let correction = false;
let failing = false;
let missingWind = false;
let restricted = false;
let missingTu = false;
let badZip = false;
let overflow = false;
let metadataMode = "normal";
const fetch = (async (input: unknown, init?: RequestInit) => {
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
    if (role === "tu") validators.push(new Headers(init?.headers).get("if-none-match"));
    const id =
      role === "tu" && missingTu ? "99999" : role === "tu" || role === "rr" ? "00044" : "00011";
    const code = { tu: "TU", rr: "nieder", ff: "wind", fx: "extrema_wind" }[role];
    return new Response(
      `<a href="10minutenwerte_${code}_${id}_now.zip">file</a> 07-Nov-2026 22:50:00 100\n`,
      {
        headers: {
          etag: overflow ? "overflow" : metadataMode !== "normal" ? "transition" : "good",
        },
      },
    );
  }
  if (url.endsWith(".txt")) {
    let bytes = fixture(`${role}-stations.txt`);
    if (role === "tu" && metadataMode !== "normal") {
      let text = bytes.toString("latin1");
      if (metadataMode === "absent") text = text.replace(/^00044[^\n]*\n/m, "");
      if (metadataMode === "ended") text = text.replace(/^(00044 \d{8} )\d{8}/m, "$120260101");
      bytes = Buffer.from(text, "latin1");
    }
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
  if (badZip && role === "tu") return new Response("bad ZIP");
  if (overflow && role === "tu") {
    const e = unzipEntries(body, { maxEntries: 8, maxBytes: 2_000_000 })[0]!;
    const rows = e.data.toString("latin1").trim().split(/\r?\n/);
    const header = rows[0]!.split(";").map((s) => s.trim());
    const cells = rows[rows.length - 1]!.split(";");
    cells[header.indexOf("TT_10")] = "9".repeat(400);
    rows[rows.length - 1] = cells.join(";");
    body = buildZip([{ name: e.name, data: rows.join("\n") }]);
  }
  if (missingTu && role === "tu") {
    const e = unzipEntries(body, { maxEntries: 8, maxBytes: 2_000_000 })[0]!;
    body = buildZip([
      {
        name: e.name.replace("00044", "99999"),
        data: e.data.toString("latin1").replace(/\b44;/g, "99999;"),
      },
    ]);
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
  return new Response(new Uint8Array(body), {
    headers: { etag: overflow ? "overflow" : metadataMode !== "normal" ? "transition" : "good" },
  });
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

const publicAir = async () =>
  (await app.inject({ url: "/observations/latest?property=weather.air_temperature" })).json()
    .records;
const publicStations = async () =>
  (await app.inject({ url: "/features?kind=weather_station&expand=components" })).json().records;
async function resetPublication() {
  qualified = true;
  metadataMode = "normal";
  correction = failing = missingWind = restricted = missingTu = badZip = overflow = false;
  roles = createRoleState();
  now = "2026-11-07T23:05:00Z";
  expect((await tick()).error).toBeUndefined();
}

test("mixed TU absence retains the metadata-supported components without refreshing missing readings", async () => {
  await resetPublication();
  const station = (await publicStations()).find(
    (s: { id: string }) => s.id === "oc:feature:de-dwd-cdc-weather:00044",
  );
  const air = await publicAir();
  const series =
    await db.sql`SELECT property,series_id,effective_from FROM conditions.observation_latest WHERE source_id=${feed.id} ORDER BY series_id`;
  missingTu = true;
  roles = createRoleState();
  now = "2026-11-07T23:07:00Z";
  expect((await tick()).error).toBeUndefined();
  const retained = (await publicStations()).find(
    (s: { id: string }) => s.id === "oc:feature:de-dwd-cdc-weather:00044",
  );
  expect(retained.components).toEqual(station.components);
  expect(retained.components.map((c: { key: string }) => c.key)).toEqual([
    "TT_10",
    "TD_10",
    "RF_10",
    "RWS_10",
  ]);
  expect(retained.details.measuredProperties).toEqual([
    "weather.air_temperature",
    "weather.dew_point",
    "weather.humidity",
    "weather.precipitation_amount",
  ]);
  expect(await publicAir()).toEqual(air);
  expect(
    await db.sql`SELECT property,series_id,effective_from FROM conditions.observation_latest WHERE source_id=${feed.id} ORDER BY series_id`,
  ).toEqual(series);
  expect(air[0].subject).toEqual({
    kind: "feature",
    featureId: "oc:feature:de-dwd-cdc-weather:00044",
    componentKey: "TT_10",
  });
  expect(air[0].id).toBe(
    "oc:observation:de-dwd-cdc-weather:41deaa822ed71bb79bc5177ea408a369cef53663002d636af7978fa0cf510d6c",
  );
  now = "2026-11-07T23:20:00Z";
  expect(await publicAir()).toEqual([]);
});

test.each(["no poll", "failed poll", "failed ZIP", "role restart"])(
  "source expiry survives %s and same-clock corrections",
  async (mode) => {
    await resetPublication();
    correction = true;
    now = "2026-11-07T23:06:00Z";
    expect((await tick()).error).toBeUndefined();
    // A held response cannot extend the source expiry either.
    now = "2026-11-07T23:06:30Z";
    expect((await tick()).error).toBeUndefined();
    now = "2026-11-07T23:19:59Z";
    const air = await publicAir();
    expect(air).toHaveLength(1);
    expect(air[0].result).toEqual({ type: "quantity", unit: "Cel", value: 7.7 });
    expect(air[0].phenomenonTime).toEqual({
      start: "2026-11-07T22:10:00Z",
      end: "2026-11-07T22:20:00Z",
    });
    expect(air[0].freshness).toEqual({
      fetchedAt: "2026-11-07T23:06:00Z",
      expiresAt: "2026-11-07T23:20:00Z",
    });
    if (mode !== "no poll") {
      if (mode === "role restart") roles = createRoleState();
      if (mode === "failed ZIP") badZip = true;
      else failing = true;
      await tick();
    }
    now = "2026-11-07T23:20:00Z";
    expect(await publicAir()).toEqual([]);
    expect((await publicStations()).map((s: { id: string }) => s.id).sort()).toEqual([
      "oc:feature:de-dwd-cdc-weather:00011",
      "oc:feature:de-dwd-cdc-weather:00044",
    ]);
  },
);

test("overflow rejects the whole generation before publication or provisional validator/state acceptance", async () => {
  await resetPublication();
  const before =
    await db.sql`SELECT * FROM conditions.observation_latest WHERE source_id=${feed.id} ORDER BY series_id`;
  const stations = await publicStations();
  const state =
    await db.sql`SELECT publication_revision,last_network_success_at FROM conditions.source_status WHERE source=${feed.id}`;
  overflow = true;
  now = "2026-11-07T23:06:00Z";
  const result = await tick();
  expect(result.error).toMatch(/non-finite/);
  expect(
    await db.sql`SELECT * FROM conditions.observation_latest WHERE source_id=${feed.id} ORDER BY series_id`,
  ).toEqual(before);
  expect(await publicStations()).toEqual(stations);
  expect(
    await db.sql`SELECT publication_revision,last_network_success_at FROM conditions.source_status WHERE source=${feed.id}`,
  ).toEqual(state);
  overflow = false;
  now = "2026-11-07T23:07:00Z";
  expect((await tick()).error).toBeUndefined();
  expect(validators.at(-1)).toBe("good");
  expect(validators.at(-2)).toBe("good");
});

test.each(["absent", "ended", "restricted"])(
  "rejects incoherent %s metadata with retained TU through worker and recovers atomically",
  async (mode) => {
    await resetPublication();
    const air = await publicAir();
    const stations = await publicStations();
    const rows =
      await db.sql`SELECT * FROM conditions.observation_latest WHERE source_id=${feed.id} ORDER BY series_id`;
    const state =
      await db.sql`SELECT publication_revision,last_network_success_at FROM conditions.source_status WHERE source=${feed.id}`;
    const individualUrl = `/features/${encodeURIComponent(air[0].subject.featureId)}?expand=components,latest`;
    const individual = await app.inject({ url: individualUrl });
    expect(individual.statusCode).toBe(200);
    metadataMode = mode;
    restricted = mode === "restricted";
    missingTu = true;
    // Reload current metadata, including across role-state loss.
    roles = createRoleState();
    now = "2026-11-07T23:07:00Z";
    const result = await tick();
    expect(result.error).toMatch(/DWD incoherent retained observation/);
    expect(await publicAir()).toEqual(air);
    expect(await publicStations()).toEqual(stations);
    expect((await app.inject({ url: individualUrl })).json()).toEqual(individual.json());
    expect(
      await db.sql`SELECT * FROM conditions.observation_latest WHERE source_id=${feed.id} ORDER BY series_id`,
    ).toEqual(rows);
    expect(
      await db.sql`SELECT publication_revision,last_network_success_at FROM conditions.source_status WHERE source=${feed.id}`,
    ).toEqual(state);
    const station = stations.find((s: { id: string }) => s.id === air[0].subject.featureId);
    expect(station.components.map((c: { key: string }) => c.key)).toContain(
      air[0].subject.componentKey,
    );
    // The failed generation's accepted listing validator must not replace "good".
    now = "2026-11-07T23:08:00Z";
    expect((await tick()).error).toMatch(/DWD incoherent retained observation/);
    expect(validators.at(-1)).toBe("good");
    if (mode === "restricted") {
      missingTu = false;
      roles = createRoleState();
      now = "2026-11-07T23:08:30Z";
      expect((await tick()).error).toBeUndefined();
      expect(await publicAir()).toEqual([]);
      expect((await publicStations()).map((s: { id: string }) => s.id)).not.toContain(
        air[0].subject.featureId,
      );
      expect((await app.inject({ url: individualUrl })).statusCode).toBe(404);
      const restrictedRows =
        await db.sql`SELECT conditions.observation_record(template,reading) AS record FROM conditions.observation_latest WHERE source_id=${feed.id} AND property='weather.air_temperature'`;
      expect(restrictedRows[0]?.record.provenance.upstream[0].attribution).toBe("Abgabe: Gesperrt");
      expect(restrictedRows[0]?.record.phenomenonTime).toEqual(air[0].phenomenonTime);
      expect(restrictedRows[0]?.record.freshness.expiresAt).toBe(air[0].freshness.expiresAt);
    }
    metadataMode = "normal";
    restricted = false;
    missingTu = false;
    roles = createRoleState();
    now = "2026-11-07T23:09:00Z";
    expect((await tick()).error).toBeUndefined();
    const recovered = await publicAir();
    expect(recovered[0].id).toBe(air[0].id);
    expect(recovered[0].phenomenonTime).toEqual(air[0].phenomenonTime);
    expect(recovered[0].freshness.expiresAt).toBe(air[0].freshness.expiresAt);
    expect(recovered[0].provenance).toEqual(air[0].provenance);
    expect(JSON.stringify(recovered)).toContain("Quelle: Deutscher Wetterdienst");
    now = "2026-11-07T23:20:00Z";
    expect(await publicAir()).toEqual([]);
  },
);
