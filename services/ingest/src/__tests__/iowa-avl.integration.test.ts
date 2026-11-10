import { readFileSync } from "node:fs";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
} from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";
import { registry } from "./helpers/situations.js";

const source = "us-ia-iowadot-maintenance";
const feed = { ...repoFeed(source) };
delete feed.disabled;
const catalog = {
  ...REPO_CATALOG,
  feeds: [...REPO_CATALOG.feeds, feed],
  sources: [...REPO_CATALOG.sources.filter((s) => s.id !== source), feed],
};
let clock = "2026-09-19T15:46:01.014Z";
const capture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/vehicles/src/__tests__/fixtures/iowa-dot-avl.json.txt",
      import.meta.url,
    ),
    "utf8",
  ),
);
let body: unknown = capture;
let db: TestDatabase;
const app = Fastify();
const roles = createRoleState();
const poll = (at: string) => {
  clock = at;
  return runSource(feed, {
    sql: db.sql,
    now: () => at,
    roles,
    fetch: (async () => new Response(JSON.stringify(body))) as typeof fetch,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    model: { registry, instanceId: "test.local" },
  });
};
const positions = async (at: string) => {
  clock = at;
  const res = await app.inject({
    method: "GET",
    url: "/observations/latest?property=vehicle.position&bbox=-97,40,-90,44",
  });
  expect(res.statusCode).toBe(200);
  return res.json().records;
};
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureObservationPartitions(db.sql, {
    classes: retentionClasses(registry),
    now: new Date(clock),
  });
  await syncSources(db.sql, [{ ...feed }]);
  registerScope(app, "iowa-integration-operator");
  registerApiRoutes(app, db.sql, { registry, now: () => new Date(clock), catalog });
  await app.ready();
}, 180000);
afterAll(async () => {
  await app.close();
  await db?.close();
});
it("publishes selected vehicles, retains missing trucks without refreshing their ping, and rolls back rejected cycles", async () => {
  expect((await poll(clock)).error).toBeUndefined();
  let read = await positions(clock);
  expect(read).toHaveLength(1);
  expect(read[0]).toMatchObject({
    phenomenonTime: { instant: clock },
    subject: { kind: "feature" },
    provenance: { sourceFormat: "iowa-avl", attribution: { license: "CC-BY-4.0" } },
    result: { value: { speed: { value: 65.855 * 1.609344, unit: "km/h" }, spreaderOn: false } },
  });
  const previous = structuredClone(roles);
  const credit = feed.attribution;
  feed.attribution = "";
  expect((await poll("2026-09-19T15:48:01.014Z")).error).toBeDefined();
  expect(roles.lastFetchedAt).toEqual(previous.lastFetchedAt);
  expect(await positions("2026-09-19T15:48:01.014Z")).toHaveLength(1);
  feed.attribution = credit;
  const duplicate = structuredClone(capture.features[0]);
  duplicate.attributes.OBJECTID = 999;
  body = { ...capture, features: [...capture.features, duplicate] };
  expect((await poll("2026-09-19T15:50:01.014Z")).error).toBeDefined();
  expect(roles.lastFetchedAt).toEqual(previous.lastFetchedAt);
  expect(roles.payloads).toEqual(previous.payloads);
  body = structuredClone(capture);
  (body as typeof capture).features[0].attributes.OBJECTID = 9876;
  (body as typeof capture).features[0].attributes.MODIFIEDDT = Date.parse(
    "2026-09-19T15:52:01.014Z",
  );
  (body as typeof capture).features[0].geometry.x = -93.57;
  expect((await poll("2026-09-19T15:52:01.014Z")).error).toBeUndefined();
  read = await positions(clock);
  expect(read).toHaveLength(1);
  expect(read[0].result.value.point.coordinates[0]).toBe(-93.57);
  body = { spatialReference: { wkid: 4326 }, features: [] };
  expect((await poll("2026-09-19T15:54:01.014Z")).error).toBeUndefined();
  expect(await positions(clock)).toHaveLength(1);
  expect(await positions("2026-09-19T16:02:01.014Z")).toHaveLength(0);
  const sources = await app.inject({ method: "GET", url: "/sources" });
  expect(sources.statusCode).toBe(200);
  expect(sources.json().sources.find((s: { id: string }) => s.id === source)).toMatchObject({
    coverage: { countries: ["US-IA"] },
    permissions: { redistribute: "yes", commercial: "yes" },
    license: "CC-BY-4.0",
  });
  const history =
    await db.sql`SELECT count(*)::int AS n FROM conditions.observation WHERE series_id IN (SELECT series_id FROM conditions.observation_latest WHERE source_id=${source})`;
  expect(history[0]?.n).toBe(0);
  body = structuredClone(capture);
  (body as typeof capture).features[0].attributes.MODIFIEDDT = null;
  expect((await poll("2026-09-19T16:02:01.014Z")).error).toBeDefined();
  // The same parser cannot bypass public egress when a source's grants prohibit redistribution.
  feed.rights = { ...feed.rights, redistribution: false, display: false };
  feed.permissions = { ...feed.permissions, redistribute: "no", display: "no" };
  feed.restricted = true;
  await syncSources(db.sql, [{ ...feed }]);
  body = structuredClone(capture);
  (body as typeof capture).features[0].attributes.MODIFIEDDT = Date.parse(
    "2026-09-19T16:04:01.014Z",
  );
  expect((await poll("2026-09-19T16:04:01.014Z")).error).toBeUndefined();
  expect(await positions(clock)).toHaveLength(0);
}, 60000);
