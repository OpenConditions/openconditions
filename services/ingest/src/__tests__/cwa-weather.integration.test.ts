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
import { runSource } from "../pipeline/run.js";
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
