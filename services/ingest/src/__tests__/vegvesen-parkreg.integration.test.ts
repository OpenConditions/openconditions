import { readFileSync } from "node:fs";
import { productionRegistry } from "@openconditions/model-registry";
import { parkregAcquisitionHash } from "@openconditions/parking";
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
const base = repoFeed("no-vegvesen-parking");
const feed = {
  ...base,
  parkreg: { qualified: true, acquisitionSha256: parkregAcquisitionHash(base) },
};
delete feed.disabled;
let db: TestDatabase;
let app: FastifyInstance;
let day = 0;
let records = structuredClone(captured);
let map = structuredClone(records);
let status = 200;
let malformed = false;
let inventoryFail = false;
let conditionalMode = "off";
let unexpected304 = false;
const roles = createRoleState();
const now = () => new Date(Date.parse("2026-11-07T12:00:00Z") + day * 86400000);
const child = createParseProcess({ minBytes: 0 });
const upstream = (async (url: string | URL | Request, init?: RequestInit) => {
  const kart = String(url).includes("datafelter=kart");
  const conditional = new Headers(init?.headers).has("if-none-match");
  if (
    unexpected304 ||
    (conditional && (conditionalMode === "all" || (conditionalMode === "mixed" && kart)))
  )
    return new Response(null, { status: 304 });
  return new Response(
    malformed
      ? "["
      : JSON.stringify(kart ? map.map((r: { id: number }) => ({ id: r.id })) : records),
    {
      status: inventoryFail && kart ? 503 : status,
      headers: { etag: "v1" },
    },
  );
}) as typeof fetch;
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
  expect(roles.urls).toEqual({});
  expect(roles.items).toEqual({});
  expect(roles.answers).toEqual({});
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
  feed.parkreg.acquisitionSha256 = parkregAcquisitionHash(feed);
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
  const body = { data: Buffer.from("excluded assessment"), bytes: 19, gzipped: false };
  roles.items["inventory"] = new Map([["old", { at: 0, body }]]);
  roles.answers["inventory"] = { old: { at: 0, body } };
  feed.rawRetention = "none";
  feed.parkreg.acquisitionSha256 = parkregAcquisitionHash(feed);
  inventoryFail = false;
  records = structuredClone(captured);
  day++;
  expect((await tick()).error).toBeUndefined();
  expect(roles.payloads).toEqual({});
  expect(roles.urls).toEqual({});
  expect(roles.items).toEqual({});
  expect(roles.answers).toEqual({});
}, 60000);

test("worker rejects equal-ID organization subsets and preserves last-good", async () => {
  day++;
  const original = await live();
  const endpoints = structuredClone(feed.endpoints);
  const receipt = feed.parkreg.acquisitionSha256;
  for (const endpoint of Object.values(feed.endpoints)) endpoint.url += "&orgnr=998472156";
  feed.parkreg.acquisitionSha256 = parkregAcquisitionHash(feed);
  records = structuredClone(captured).slice(0, 1);
  map = structuredClone(records);
  expect((await tick()).error).toMatch(/national acquisition/);
  expect(await live()).toEqual(original);
  feed.endpoints = endpoints;
  feed.parkreg.acquisitionSha256 = receipt;
}, 60000);

test("no-retention re-evaluates activation/end dates across mixed and all conditional polls", async () => {
  for (const mode of ["mixed", "all"]) {
    conditionalMode = "off";
    records = structuredClone(captured);
    map = structuredClone(records);
    day++;
    records[0].aktivVersjon.sluttidspunkt = new Date(now().getTime() + 86400000).toISOString();
    records[1].aktivVersjon.aktiveringstidspunkt = records[0].aktivVersjon.sluttidspunkt;
    expect((await tick()).error).toBeUndefined();
    expect(await live()).toEqual([`oc:feature:${feed.id}:32771`]);
    day++;
    conditionalMode = mode;
    expect((await tick()).error).toBeUndefined();
    expect(await live()).toEqual([`oc:feature:${feed.id}:98316`]);
    expect(roles.payloads).toEqual({});
    expect(roles.urls).toEqual({});
    expect(roles.items).toEqual({});
    expect(roles.answers).toEqual({});
    const original = await live();
    day++;
    unexpected304 = true;
    expect((await tick()).error).toBeDefined();
    expect(await live()).toEqual(original);
    unexpected304 = false;
  }
  conditionalMode = "off";
}, 60000);

test("unknown total capacity keeps a valid site through the worker and public API", async () => {
  day++;
  records = structuredClone(captured);
  map = structuredClone(captured);
  records[0].aktivVersjon.antallAvgiftsfriePlasser = null;
  expect((await tick()).error).toBeUndefined();
  expect(await live()).toHaveLength(2);
  const response = await app.inject({ url: `/features?source=${feed.id}` });
  expect(response.statusCode).toBe(200);
  const site = response.json().records.find((r: { id: string }) => r.id.endsWith(":32771"));
  expect(site).toBeDefined();
  expect(site.details).not.toHaveProperty("capacityTotal");
  expect(await db.sql`SELECT * FROM conditions.observation`).toHaveLength(0);
  expect(await db.sql`SELECT id FROM conditions.offer WHERE source_id=${feed.id}`).toHaveLength(0);
}, 60000);
