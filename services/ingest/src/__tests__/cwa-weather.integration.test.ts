import { readFileSync } from "node:fs";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
} from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { formatOf } from "../domains.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";

const registry = productionRegistry();
const feed = structuredClone(repoFeed("tw-cwa-weather"));
// Simulate operator qualification only against the local fixture transport.
delete feed.disabled;
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/weather/src/__tests__/fixtures/tw-cwa-preview.txt",
      import.meta.url,
    ),
    "utf8",
  ),
);
let db: TestDatabase;
let app: ReturnType<typeof Fastify>;
let now = "2026-11-08T06:11:00Z";
const requests: Headers[] = [];
const poll = (body: unknown, env: Record<string, string> = {}) =>
  runSource(feed, {
    sql: db.sql,
    now: () => now,
    model: { registry, instanceId: "test.local" },
    env,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: (async (_url, init) => {
      requests.push(new Headers(init?.headers));
      return new Response(JSON.stringify(body));
    }) as typeof fetch,
  });
beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [{ ...feed, restricted: false }]);
  await ensureObservationPartitions(db.sql, {
    classes: retentionClasses(registry),
    now: new Date(now),
  });
  app = Fastify();
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

test("CWA worker fails closed without configuration before any request", async () => {
  expect((await poll(fixture)).outcome).toBe("missing_configuration");
  expect(requests).toHaveLength(0);
});

test("CWA worker and public API preserve source times, notices, retention and incomplete fleet", async () => {
  // Synthetic operator configuration, never a provider request or credential.
  const env = { TW_CWA_WEATHER_API_KEY: "fixture-only" };
  const first = structuredClone(fixture);
  for (const id of ["466941", "466942"])
    first.records.Station.push({ ...structuredClone(first.records.Station[0]), StationId: id });
  const result = await poll(first, env);
  expect(result.error).toBeUndefined();
  expect(result.outcome).toBe("changed");
  expect(requests.at(-1)?.get("Authorization")).toBe("fixture-only");
  const res = await app.inject({ url: "/features?source=tw-cwa-weather&expand=latest" });
  expect(res.statusCode).toBe(200);
  expect(JSON.stringify(res.json())).toContain("OGDL-Taiwan-1.0");
  expect(JSON.stringify(res.json())).toContain("交通部中央氣象署");
  expect(JSON.stringify(res.json())).toContain("2026-11-08T06:10:00Z");
  expect(JSON.stringify(res.json())).toContain('"value":62');
  const sources = await app.inject({ url: "/sources" });
  expect(sources.body).toContain("https://data.gov.tw/license");
  expect(sources.body).toContain("O-A0003-001");
  // A valid smaller response must never withdraw the omitted stations, even after tripwire confirmation.
  for (let i = 0; i < 4; i++) await poll(fixture, env);
  const live =
    await db.sql`SELECT id FROM conditions.feature WHERE source_id = ${feed.id} AND tombstoned_at IS NULL`;
  expect(live).toHaveLength(3);
  const bad = structuredClone(fixture);
  bad.records.Station.push(bad.records.Station[0]);
  expect((await poll(bad, env)).error).toBeDefined();
  expect(
    await db.sql`SELECT id FROM conditions.feature WHERE source_id = ${feed.id} AND tombstoned_at IS NULL`,
  ).toHaveLength(3);
  const observations = await app.inject({ url: "/observations/latest?source=tw-cwa-weather" });
  expect(observations.body).toContain('"value":62');
  await db.sql`UPDATE conditions.source SET restricted = true WHERE id = ${feed.id}`;
  expect(
    (await app.inject({ url: "/features?source=tw-cwa-weather&expand=latest" })).body,
  ).not.toContain('"value":62');
  expect(
    (await app.inject({ url: "/observations/latest?source=tw-cwa-weather" })).body,
  ).not.toContain('"value":62');
  await db.sql`UPDATE conditions.source SET restricted = false WHERE id = ${feed.id}`;
  now = "2026-11-08T07:09:00Z";
  expect((await poll(fixture, env)).error).toBeUndefined();
  now = "2026-11-08T07:11:00Z";
  const expired = await app.inject({ url: "/observations/latest?source=tw-cwa-weather" });
  expect(expired.statusCode).toBe(200);
  expect(expired.body).not.toContain('"value":62');
});

for (const failure of ["parse", "storage", "canonical", "withheld"] as const) {
  test(`CWA ${failure} keeps accepted cadence and permits immediate recovery`, async () => {
    now = "2026-11-08T06:11:00Z";
    const roles = createRoleState();
    const source = structuredClone(feed);
    source.id = `${feed.id}-${failure}`;
    source.endpoints.main!.url += `&test=${failure}`;
    await syncSources(db.sql, [{ ...source, restricted: false }]);
    let body = structuredClone(fixture);
    let etag = '"accepted"';
    const headers: Headers[] = [];
    const options = {
      sql: db.sql,
      now: () => now,
      roles,
      model: { registry, instanceId: "test.local" },
      env: { [`${source.id.replaceAll("-", "_").toUpperCase()}_API_KEY`]: "fixture-only" },
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: (async (_url, init) => {
        const request = new Headers(init?.headers);
        headers.push(request);
        return request.get("if-none-match") === etag
          ? new Response(null, { status: 304 })
          : new Response(JSON.stringify(body), { headers: { ETag: etag } });
      }) as typeof fetch,
    };
    expect((await runSource(source, options)).outcome).toBe("changed");
    const acceptedAt = roles.lastFetchedAt.main;
    const rows = () =>
      db.sql`SELECT record FROM conditions.feature WHERE source_id = ${source.id} ORDER BY id`;
    const readings = () =>
      db.sql`SELECT reading FROM conditions.observation_latest WHERE source_id = ${source.id} ORDER BY series_id`;
    const before = await rows();
    const beforeReadings = await readings();
    const publicReadings = async () =>
      (await app.inject({ url: `/observations/latest?source=${source.id}` })).json();
    const beforePublic = await publicReadings();
    now = "2026-11-08T06:11:01Z";
    expect((await runSource(source, options)).notDue).toBe(true);
    expect(headers).toHaveLength(1);
    now = "2026-11-08T06:22:00Z";
    roles.failing.main = true;
    etag = '"candidate"';
    body.records.Station[0].WeatherElement.RelativeHumidity = "63";
    const format = formatOf(source);
    const originalParse = format.parse;
    if (failure === "parse") body.records.Station.push(body.records.Station[0]);
    if (failure === "storage") {
      body.records.Station[0].StationName = "changed station";
      await db.sql.unsafe(
        `CREATE FUNCTION conditions.cwa_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture storage failure'; END $$`,
      );
      await db.sql.unsafe(
        `CREATE TRIGGER cwa_reject BEFORE UPDATE ON conditions.feature FOR EACH ROW EXECUTE FUNCTION conditions.cwa_reject()`,
      );
    }
    if (failure === "canonical" || failure === "withheld") {
      format.parse = (...args) => {
        const output = originalParse(...args);
        if (failure === "canonical") output.features[0]!.kind = "invalid-kind";
        else output.features = [];
        return output;
      };
    }
    try {
      const result = await runSource(source, options);
      expect(result.error).toBeDefined();
      expect.soft(roles.lastFetchedAt.main).toBe(acceptedAt);
      expect.soft(roles.failing.main).toBe(true);
      expect.soft(await rows()).toEqual(before);
      expect.soft(await readings()).toEqual(beforeReadings);
      expect.soft(await publicReadings()).toEqual(beforePublic);
      const [status] =
        await db.sql`SELECT last_outcome, last_error FROM conditions.source_status WHERE source = ${source.id}`;
      expect(status!.last_outcome).toBe("failed");
      expect(status!.last_error).toBeTruthy();
    } finally {
      format.parse = originalParse;
      if (failure === "storage") {
        await db.sql.unsafe(`DROP TRIGGER cwa_reject ON conditions.feature`);
        await db.sql.unsafe(`DROP FUNCTION conditions.cwa_reject()`);
      }
    }
    now = "2026-11-08T06:22:01Z";
    if (failure === "parse") body = structuredClone(fixture);
    body.records.Station[0].WeatherElement.RelativeHumidity = "63";
    // Candidate ETag stays identical: a consumed validator would lose this recovery.
    expect((await runSource(source, options)).outcome).toBe("changed");
    expect(headers.at(-1)?.get("if-none-match")).toBe('"accepted"');
    expect(roles.lastFetchedAt.main).toBe(Date.parse(now));
    expect(roles.failing.main).toBeUndefined();
    expect(JSON.stringify(await readings())).toContain("63");
    expect(JSON.stringify(await rows())).toContain("OGDL-Taiwan-1.0");
    expect(JSON.stringify(await rows())).toContain("交通部中央氣象署");
    now = "2026-11-08T06:22:02Z";
    expect((await runSource(source, options)).notDue).toBe(true);
    now = "2026-11-08T06:33:00Z";
    expect((await runSource(source, options)).outcome).toBe("validated_unchanged");
    expect(headers.at(-1)?.get("if-none-match")).toBe('"candidate"');
    expect(roles.lastFetchedAt.main).toBe(Date.parse(now));
    now = "2026-11-08T06:33:01Z";
    expect((await runSource(source, options)).notDue).toBe(true);
    await syncSources(db.sql, [{ ...source, restricted: true }]);
    expect(JSON.stringify(await publicReadings())).not.toContain('"value":63');
    await syncSources(db.sql, [{ ...source, restricted: false }]);
    now = "2026-11-08T07:11:00Z";
    expect(JSON.stringify(await publicReadings())).not.toContain('"value":63');
  });
}
