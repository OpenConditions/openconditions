import { readFileSync } from "node:fs";
import { productionRegistry } from "@openconditions/model-registry";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createParseProcess } from "../pipeline/parse-process.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";
import { fakeLookup } from "./helpers/on-demand.js";

const captured = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/parking/src/__tests__/fixtures/vegvesen-parkreg.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const feed = { ...repoFeed("no-vegvesen-parking"), parkreg: { qualified: true } };
delete feed.disabled;
let db: TestDatabase;
let app: FastifyInstance;
let day = 0;
let records = structuredClone(captured);
let map = structuredClone(records);
let status = 200;
let malformed = false;
let inventoryFail = false;
const roles = createRoleState();
const now = () => new Date(Date.parse("2026-11-07T12:00:00Z") + day * 86400000);
const child = createParseProcess({ minBytes: 0 });
const upstream = (async (url: string | URL | Request) =>
  new Response(
    malformed
      ? "["
      : JSON.stringify(
          String(url).includes("datafelter=kart")
            ? map.map((r: { id: number }) => ({ id: r.id }))
            : records,
        ),
    { status: inventoryFail && String(url).includes("datafelter=kart") ? 503 : status },
  )) as typeof fetch;
const tick = () =>
  runSource(feed, {
    sql: db.sql,
    fetch: upstream,
    lookup: fakeLookup,
    now: () => now().toISOString(),
    model: { registry: productionRegistry(), instanceId: "test.local" },
    parseProcess: child,
    roles,
  });
const live = async () =>
  (
    await db.sql`SELECT id FROM conditions.feature WHERE source_id=${feed.id} AND tombstoned_at IS NULL ORDER BY id`
  ).map((r) => r["id"]);
beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [feed]);
  app = Fastify();
  registerScope(app, "test-token");
  registerApiRoutes(app, db.sql, {
    registry: productionRegistry(),
    now,
    catalog: { sources: [feed] },
  });
  await app.ready();
}, 120000);
afterAll(async () => {
  await child.close();
  await app?.close();
  await db?.close();
});

test("qualified worker snapshot reaches public API and only complete snapshots withdraw", async () => {
  expect((await tick()).error).toBeUndefined();
  expect(roles.payloads).toEqual({});
  const original = await live();
  expect(original).toHaveLength(2);
  const response = await app.inject({
    url: `/features?source=${feed.id}&expand=components,latest,offers`,
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.records).toHaveLength(2);
  expect(JSON.stringify(body)).toContain("NLOD-2.0");
  expect(JSON.stringify(body)).toContain("Normalisert av OpenConditions");
  expect(JSON.stringify(body)).toContain("car:disabled");
  expect(JSON.stringify(body)).not.toContain("vurderingForflytningshemmede");
  const sources = await app.inject({ url: "/sources" });
  expect(sources.statusCode).toBe(200);
  expect(sources.body).toContain("Statens vegvesen");
  expect(sources.body).toContain("https://data.norge.no/nlod/no/2.0");
  expect(await db.sql`SELECT * FROM conditions.observation`).toHaveLength(0);
  expect(await db.sql`SELECT id FROM conditions.offer WHERE source_id=${feed.id}`).toHaveLength(0);
  for (const mode of ["partial", "malformed", "provider", "unqualified", "inventory-failure"]) {
    day++;
    records = structuredClone(captured);
    map = structuredClone(captured);
    status = 200;
    malformed = false;
    inventoryFail = false;
    feed.parkreg.qualified = true;
    if (mode === "inventory-failure") {
      inventoryFail = true;
      records[0].deaktivert = { deaktivertTidspunkt: now().toISOString() };
    }
    if (mode === "partial") records = records.slice(1);
    if (mode === "malformed") malformed = true;
    if (mode === "provider") status = 503;
    if (mode === "unqualified") feed.parkreg.qualified = false;
    expect((await tick()).error, mode).toBeDefined();
    expect(await live(), mode).toEqual(original);
  }
  day++;
  status = 200;
  malformed = false;
  inventoryFail = false;
  feed.parkreg.qualified = true;
  records = structuredClone(captured);
  map = structuredClone(captured);
  records[0].deaktivert = { deaktivertTidspunkt: now().toISOString() };
  expect((await tick()).error).toBeUndefined();
  expect(await live()).toHaveLength(1);
  day++;
  records = [];
  map = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await tick()).error).toBeDefined();
    expect(await live()).toHaveLength(1);
    day++;
  }
  expect((await tick()).error).toBeUndefined();
  expect(await live()).toEqual([]);
}, 60000);

test("qualified snapshot cannot withdraw through held-role fallback and no-retention drops old caches", async () => {
  feed.rawRetention = "reference";
  inventoryFail = false;
  records = structuredClone(captured);
  map = structuredClone(captured);
  day++;
  expect((await tick()).error).toBeUndefined();
  expect(await live()).toHaveLength(2);
  day++;
  inventoryFail = true;
  records[0].deaktivert = { deaktivertTidspunkt: now().toISOString() };
  expect((await tick()).error).toMatch(/successful acquisition/);
  expect(await live()).toHaveLength(2);
  feed.rawRetention = "none";
  inventoryFail = false;
  records = structuredClone(captured);
  day++;
  expect((await tick()).error).toBeUndefined();
  expect(roles.payloads).toEqual({});
}, 60000);
