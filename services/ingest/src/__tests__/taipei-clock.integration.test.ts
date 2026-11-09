import { readFileSync } from "node:fs";
import { productionRegistry } from "@openconditions/model-registry";
import type { ParkingCatalogFeed } from "@openconditions/parking";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
} from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";

let db: TestDatabase;
let app = Fastify();
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
let requests: string[] = [];
let notModified = false;
let roles: ReturnType<typeof createRoleState> | undefined;
const qualified = false;
beforeEach(async () => {
  app = Fastify();
  now = "2026-11-07T08:26:00Z";
  sites = fixture("sites");
  status = Buffer.from(fixture("status").toString().replace("16:10", "16:00"));
  roles = createRoleState();
  notModified = false;
  requests = [];
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
afterEach(async () => {
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
    fetch: async (url, init) => {
      requests.push(String(url));
      if (notModified) expect(new Headers(init?.headers).get("if-none-match")).toBe('"snapshot"');
      if (notModified) return new Response(null, { status: 304 });
      return new Response(String(url).includes("alldesc") ? sites : status, {
        headers: { ETag: '"snapshot"' },
      });
    },
  });
}
async function latest(canonical: boolean) {
  const response = await app.inject(
    `/features?kind=parking_site&expand=latest&canonical=${canonical ? 1 : 0}`,
  );
  expect(response.statusCode, response.body).toBe(200);
  return Object.values(response.json().latest ?? {}).flat();
}
it("expires persisted canonical/public fusion by advancing only the API read clock", async () => {
  expect((await poll()).count).toBeGreaterThan(0);
  const fused = await latest(true);
  expect(fused.length).toBeGreaterThan(0);
  expect(fused).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "@fused", validUntil: "2026-11-07T08:30:00.000Z" }),
    ]),
  );
  now = "2026-11-07T08:30:01Z";
  expect(await latest(false)).toEqual([]);
  expect(await latest(true)).toEqual([]);
});
it("keeps network validation separate during repeated persistent-role 304s", async () => {
  now = "2026-11-07T08:11:00Z";
  status = fixture("status");
  expect((await poll()).count).toBeGreaterThan(0);
  notModified = true;
  for (const at of ["2026-11-07T08:16:00Z", "2026-11-07T08:21:00Z", "2026-11-07T08:41:00Z"]) {
    requests = [];
    now = at;
    expect((await poll()).count).toBe(0);
    const [state] = await db.sql`SELECT * FROM conditions.source_status WHERE source=${base.id}`;
    expect(new Date(state!.last_network_success_at).toISOString()).toBe(new Date(at).toISOString());
    expect(new Date(state!.last_success_at).toISOString()).toBe("2026-11-07T08:11:00.000Z");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("allavailable");
    if (at > "2026-11-07T08:40:00Z") {
      expect(await latest(false)).toEqual([]);
      expect(await latest(true)).toEqual([]);
    }
  }
});
it("accepts delayed increasing publication clocks but refuses same and backwards replay", async () => {
  expect((await poll()).count).toBeGreaterThan(0);
  now = "2026-11-07T08:31:00Z";
  status = Buffer.from(
    status
      .toString()
      .replace("16:00", "16:05")
      .replace("<AVAILABLECAR>17</AVAILABLECAR>", "<AVAILABLECAR>16</AVAILABLECAR>"),
  );
  expect((await poll()).outcome).toBe("changed");
  roles = undefined;
  now = "2026-11-07T08:32:00Z";
  expect((await poll()).error).toContain("source publication did not advance");
  now = "2026-11-07T08:33:00Z";
  status = Buffer.from(status.toString().replace("16:05", "16:04"));
  expect((await poll()).error).toContain("source publication did not advance");
});

it("rolls back the publication clock and rows together, then permits retry", async () => {
  await poll();
  const before =
    await db.sql`SELECT reading FROM conditions.observation_latest ORDER BY source_id, series_id`;
  await db.sql`CREATE FUNCTION conditions.reject_clock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_published_at > OLD.source_published_at THEN RAISE EXCEPTION 'injected clock rollback'; END IF;
    RETURN NEW; END $$`;
  await db.sql`CREATE TRIGGER reject_clock BEFORE UPDATE ON conditions.source_status FOR EACH ROW EXECUTE FUNCTION conditions.reject_clock()`;
  now = "2026-11-07T08:31:00Z";
  status = Buffer.from(
    status
      .toString()
      .replace("16:00", "16:05")
      .replace("<AVAILABLECAR>17</AVAILABLECAR>", "<AVAILABLECAR>16</AVAILABLECAR>"),
  );
  expect((await poll()).count).toBe(0);
  expect(
    await db.sql`SELECT reading FROM conditions.observation_latest ORDER BY source_id, series_id`,
  ).toEqual(before);
  const [state] =
    await db.sql`SELECT source_published_at FROM conditions.source_status WHERE source=${base.id}`;
  expect(new Date(state!.source_published_at).toISOString()).toBe("2026-11-07T08:00:00.000Z");
  await db.sql`DROP TRIGGER reject_clock ON conditions.source_status`;
  // Retry with a new role session, while the source publication is still within its age window.
  roles = createRoleState();
  now = "2026-11-07T08:32:00Z";
  expect((await poll()).outcome).toBe("changed");
});
it("serializes concurrent acceptance of the same source clock", async () => {
  await poll();
  now = "2026-11-07T08:31:00Z";
  status = Buffer.from(
    status
      .toString()
      .replace("16:00", "16:05")
      .replace("<AVAILABLECAR>17</AVAILABLECAR>", "<AVAILABLECAR>16</AVAILABLECAR>"),
  );
  roles = undefined;
  const results = await Promise.all([poll(), poll()]);
  expect(results.filter((r) => r.outcome === "changed")).toHaveLength(1);
  const [state] =
    await db.sql`SELECT source_published_at, publication_revision FROM conditions.source_status WHERE source=${base.id}`;
  expect(new Date(state!.source_published_at).toISOString()).toBe("2026-11-07T08:05:00.000Z");
  expect(Number(state!.publication_revision)).toBe(2);
});
