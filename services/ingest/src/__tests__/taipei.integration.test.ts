import { readFileSync } from "node:fs";
import { productionRegistry } from "@openconditions/model-registry";
import { type ParkingCatalogFeed, rateDraft } from "@openconditions/parking";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
  writeSnapshot,
} from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";

let db: TestDatabase;
const app = Fastify();
let now = "2026-11-07T08:11:00Z";
const base = structuredClone(repoFeed("tw-tpe-pma-parking")) as ParkingCatalogFeed;
delete base.disabled;
const fixture = (role: string) =>
  readFileSync(
    new URL(
      `../../../../packages/parking/src/__tests__/fixtures/taipei-${role}.xml`,
      import.meta.url,
    ),
  );
let sites = fixture("sites");
let status = fixture("status");
let failed = false;
let failStatus = false;
let roles: ReturnType<typeof createRoleState> | undefined;
let qualified = true;
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureObservationPartitions(db.sql, {
    classes: retentionClasses(productionRegistry()),
    now: new Date(now),
  });
  await syncSources(db.sql, [base]);
  registerScope(app, undefined);
  registerApiRoutes(app, db.sql, {
    registry: productionRegistry(),
    catalog: { sources: [base] },
    now: () => new Date(now),
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db?.close();
});
async function poll() {
  const feed = { ...base, taipei: { qualifiedSnapshot: qualified } };
  return runSource(feed, {
    sql: db.sql,
    roles,
    now: () => now,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      if (failed || (failStatus && !String(url).includes("alldesc")))
        return new Response("outage", { status: 503 });
      return new Response(String(url).includes("alldesc") ? sites : status);
    },
  });
}
async function rows() {
  return db.sql`SELECT reading FROM conditions.observation_latest WHERE source_id=${base.id}`;
}
function advance(minute: number, body: string) {
  now = `2026-11-07T08:${String(minute + 1).padStart(2, "0")}:00Z`;
  status = Buffer.from(
    `<DATA><UPDATETIME>Sat Nov 07 16:${String(minute).padStart(2, "0")}:00 CST 2026</UPDATETIME>${body}</DATA>`,
  );
}
const row = (v: string) => `<PARK><ID>TPE0001</ID><AVAILABLECAR>${v}</AVAILABLECAR></PARK>`;
it("publishes sealed components and rights, retains failures and unqualified omissions, ends qualified missing categories and reappears", async () => {
  expect((await poll()).count).toBeGreaterThan(0);
  const res = await app.inject("/features?bbox=121.2,24.8,121.8,25.3&kind=parking_site");
  expect(res.statusCode, res.body).toBe(200);
  expect(res.body).toContain("TPE0001");
  expect(res.body).toContain("zh-Hant");
  const sources = await app.inject("/sources");
  expect(sources.statusCode).toBe(200);
  expect(sources.body).toContain("OGDL-Taiwan-1.0");
  expect(sources.body).toContain("臺北市停車管理工程處 2026");
  const offer = rateDraft(base, "TPE0001", 0, {
    currency: "TWD",
    rows: [{ amount: 1 }],
    fetchedAt: now,
  })!;
  const written = await writeSnapshot(
    db.sql,
    base.id,
    { offers: [offer] },
    { registry: productionRegistry(), instanceId: "test.local", now, complete: false },
  );
  expect(written.rejected).toEqual([]);
  const initial = await rows();
  expect(initial.length).toBeGreaterThan(0);
  // Same snapshot fetched later cannot refresh source success or counts.
  now = "2026-11-07T08:12:00Z";
  expect((await poll()).count).toBe(0);
  const [unchanged] =
    await db.sql`SELECT last_success_at FROM conditions.source_status WHERE source=${base.id}`;
  expect(new Date(unchanged!.last_success_at).toISOString()).toBe("2026-11-07T08:11:00.000Z");
  for (const body of ["<DATA/>", "<ERROR>down</ERROR>", "<DATA><PARK>"]) {
    status = Buffer.from(body);
    now = "2026-11-07T08:13:00Z";
    expect((await poll()).count).toBe(0);
    expect(await rows()).toEqual(initial);
  }
  failed = true;
  expect((await poll()).count).toBe(0);
  expect(await rows()).toEqual(initial);
  failed = false;
  const siteRows = sites.toString().match(/<PARK>[\s\S]*?<\/PARK>/g)!;
  sites = Buffer.from(sites.toString().replace(siteRows[siteRows.length - 1]!, ""));
  qualified = false;
  advance(15, row("-9"));
  await poll();
  expect((await rows()).every((r) => r.reading.validUntil === undefined)).toBe(true);
  expect(
    await db.sql`SELECT id FROM conditions.feature WHERE source_id=${base.id} AND tombstoned_at IS NULL`,
  ).toHaveLength(5);
  qualified = true;
  for (const minute of [20, 25, 30]) {
    advance(minute, row("-9"));
    await poll();
  }
  expect((await rows()).every((r) => r.reading.validUntil !== undefined)).toBe(true);
  expect(
    await db.sql`SELECT id FROM conditions.feature WHERE source_id=${base.id} AND tombstoned_at IS NULL`,
  ).toHaveLength(4);
  expect(
    await db.sql`SELECT id FROM conditions.offer WHERE source_id=${base.id} AND tombstoned_at IS NULL`,
  ).toHaveLength(1);
  advance(35, row("0"));
  await poll();
  expect(
    (await rows()).some((r) => r.reading.result.value === 0 && r.reading.validUntil === undefined),
  ).toBe(true);
  for (const minute of [40, 45, 50]) {
    advance(minute, row("-6"));
    await poll();
  }
  expect((await rows()).every((r) => r.reading.validUntil !== undefined)).toBe(true);
  advance(55, row("2"));
  await poll();
  expect(
    (await rows()).some((r) => r.reading.result.value === 2 && r.reading.validUntil === undefined),
  ).toBe(true);
  const api = await app.inject(
    "/observations/latest?bbox=121.2,24.8,121.8,25.3&property=parking.available",
  );
  expect(api.statusCode, api.body).toBe(200);
  expect(api.body).toContain("componentKey");
  expect(api.body).toContain("08:55:00");
  expect(api.body).toContain("09:25:00");
  roles = createRoleState();
  now = "2026-11-07T09:01:00Z";
  status = Buffer.from(
    `<DATA><UPDATETIME>Sat Nov 07 17:00:00 CST 2026</UPDATETIME>${row("3")}</DATA>`,
  );
  await poll();
  const beforeHeld = await rows();
  now = "2026-11-07T09:06:00Z";
  roles.lastFetchedAt["sites"] = 0;
  failStatus = true;
  expect((await poll()).count).toBe(0);
  expect(await rows()).toEqual(beforeHeld);
}, 60000);
