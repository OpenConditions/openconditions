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
import { createParseProcess } from "../pipeline/parse-process.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";
import { registry } from "./helpers/situations.js";

const source = "us-ia-iowadot-maintenance";
const feed = repoFeed(source);
const fixtures = new URL("../../../../packages/vehicles/src/__tests__/fixtures/", import.meta.url);
const bytes = readFileSync(new URL("iowa-live-1.json.txt", fixtures));
const raw: {
  features: {
    attributes: {
      LABEL: string;
      MODIFIEDDT: number;
      HEADING: number;
      VELOCITY: number;
      ROUTE_NAME: string;
      ACTIVE_MATERIAL: string;
    };
    geometry: { x: number; y: number };
  }[];
} = JSON.parse(bytes.toString());
let body = bytes;
let clock = "2026-11-09T17:28:40.247Z";
let db: TestDatabase;
const app = Fastify();
const roles = createRoleState();
const child = createParseProcess({ minBytes: 0 });
const poll = (at: string) => {
  clock = at;
  return runSource(feed, {
    sql: db.sql,
    now: () => at,
    roles,
    parseProcess: child,
    fetch: (async () => new Response(body.toString())) as typeof fetch,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    model: { registry, instanceId: "test.local" },
  });
};
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureObservationPartitions(db.sql, {
    classes: retentionClasses(registry),
    now: new Date(clock),
  });
  await syncSources(db.sql, [{ ...feed }]);
  await db.sql`INSERT INTO conditions.federation_subscription (id, peer_id, delivery_mode, filter, created_at, updated_at) VALUES ('iowa-sub', 'iowa-peer', 'pull', ${db.sql.json({ classes: ["feature", "observation"], properties: ["vehicle.position"] })}, now(), now())`;
  registerScope(app, "iowa-live-test");
  registerApiRoutes(app, db.sql, { registry, now: () => new Date(clock), catalog: REPO_CATALOG });
  await app.ready();
}, 180000);
afterAll(async () => {
  await child.close();
  await app.close();
  await db?.close();
});

it("publishes every captured selected row through guarded acquisition, production parsing, PostGIS, API and federation", async () => {
  expect(feed.disabled).toBeUndefined();
  expect((await poll(clock)).error).toBeUndefined();
  const read = await app.inject({
    method: "GET",
    url: "/observations/latest?property=vehicle.position&bbox=-97,40,-90,44",
  });
  expect(read.statusCode).toBe(200);
  const records = read.json().records;
  expect(records).toHaveLength(39);
  for (const { attributes: a, geometry: g } of raw.features) {
    const id = `oc:feature:${source}:${encodeURIComponent(a.LABEL)}`;
    const record = records.find(
      (r: { subject: { featureId: string } }) => r.subject.featureId === id,
    );
    expect(record).toMatchObject({
      subject: { kind: "feature", featureId: id },
      phenomenonTime: { instant: new Date(a.MODIFIEDDT).toISOString() },
      freshness: { expiresAt: new Date(a.MODIFIEDDT + 600000).toISOString() },
      provenance: {
        sourceFormat: "iowa-avl",
        attribution: { license: "CC-BY-4.0", provider: feed.attribution },
      },
      result: {
        value: {
          point: { type: "Point", coordinates: [g.x, g.y] },
          bearingDeg: a.HEADING % 360,
          speed: { value: a.VELOCITY * 1.609344, unit: "km/h" },
          routeName: a.ROUTE_NAME,
          spreaderOn: false,
        },
      },
    });
    expect(record.result.value).not.toHaveProperty("plowUp");
    expect(record.result.value).not.toHaveProperty("activity");
  }
  const geo = await app.inject({ method: "GET", url: `/features.geojson?source=${source}` });
  expect(geo.statusCode).toBe(200);
  expect(geo.json().features).toHaveLength(39);
  const journal =
    await db.sql`SELECT snapshot FROM conditions.federation_outbox WHERE record_class='observation'`;
  expect(journal).toHaveLength(39);
  for (const row of journal) {
    expect(row.snapshot.provenance.sourceFormat).toBe("iowa-avl");
    expect(row.snapshot.provenance.attribution.license).toBe("CC-BY-4.0");
    expect(row.snapshot).not.toHaveProperty("extras");
  }
  body = readFileSync(new URL("iowa-live-2.json.txt", fixtures));
  expect((await poll("2026-11-09T17:31:04.534Z")).error).toBeUndefined();
  const count =
    await db.sql`SELECT count(*)::int AS n FROM conditions.observation_latest WHERE source_id=${source}`;
  expect(count[0]?.n).toBe(39);
  body = Buffer.from('{"features":[]}');
  expect((await poll("2026-11-09T17:33:04.534Z")).error).toBeUndefined();
  const retained = await app.inject({
    method: "GET",
    url: "/observations/latest?property=vehicle.position&bbox=-97,40,-90,44",
  });
  expect(retained.json().records).toHaveLength(39);
  body = Buffer.from('{"features":[{}]}');
  expect((await poll("2026-11-09T17:35:04.534Z")).error).toBeDefined();
  clock = "2026-11-09T17:40:00.000Z";
  const expired = await app.inject({
    method: "GET",
    url: "/observations/latest?property=vehicle.position&bbox=-97,40,-90,44",
  });
  expect(expired.json().records).toHaveLength(0);
}, 60000);
