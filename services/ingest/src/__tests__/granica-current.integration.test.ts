import { readFileSync } from "node:fs";
import { contentHash } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
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
import { repoFeed } from "./helpers/catalog.js";

const feed = repoFeed("pl-granica-waits");
const registry = productionRegistry();
const body = readFileSync(
  new URL(
    "../../../../packages/border/src/__tests__/fixtures/granica-2026-11-09.html.txt",
    import.meta.url,
  ),
  "utf8",
);
let db: TestDatabase;
let now = "2026-11-09T18:26:35.741Z";
const app = Fastify();
let roles = createRoleState();
let requests = 0;
const validators: (string | null)[] = [];
const poll = (payload: string | null = body, status = 200) =>
  runSource(feed, {
    sql: db.sql,
    now: () => now,
    roles,
    model: { registry, instanceId: "test.local" },
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: (async (_url, init) => {
      requests++;
      validators.push(new Headers(init?.headers).get("if-none-match"));
      return new Response(payload, { status, headers: { etag: '"granica-fixed"' } });
    }) as typeof fetch,
  });
beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [feed]);
  await db.sql`INSERT INTO conditions.federation_subscription (id, peer_id, delivery_mode, filter, created_at, updated_at) VALUES ('granica', 'granica-peer', 'pull', ${db.sql.json({ properties: ["border.wait"] })}, now(), now())`;
  await ensureObservationPartitions(db.sql, {
    classes: retentionClasses(registry),
    now: new Date(now),
  });
  registerScope(app, "operator-token-granica-integration-0123456789");
  registerApiRoutes(app, db.sql, { registry, now: () => new Date(now) });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db?.close();
});
const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
it("runs the worker and hides source/fused waits at source expiry before any cleanup", async () => {
  const first = await poll();
  expect(first.error).toBeUndefined();
  expect((await get("/observations/latest?property=border.wait")).records).toHaveLength(6);
  expect((await get("/observations/latest?property=border.wait&canonical=1")).records).toHaveLength(
    6,
  );
  const sourceRows = (await get("/observations/latest?property=border.wait")).records;
  expect(
    sourceRows
      .map((r: { result: { value: { waitMinutes: number } } }) => r.result.value.waitMinutes)
      .sort((a: number, b: number) => a - b),
  ).toEqual([0, 0, 120, 180, 600, 780]);
  const initial = await get("/features?kind=border_crossing&expand=latest,components");
  expect(initial.records).toHaveLength(3);
  expect(Object.values(initial.latest).flat()).toHaveLength(6);
  expect(JSON.stringify(initial)).toContain("Ministerstwo Finansów");
  expect(JSON.stringify(initial)).toContain("CC0-1.0");
  expect(JSON.stringify(initial)).toContain("maximumPermissibleGrossMass");
  const geo = await get("/features.geojson?kind=border_crossing&expand=components");
  expect(geo.features).toHaveLength(3);
  expect(JSON.stringify(geo)).toContain("CC0-1.0");
  const journal =
    await db.sql`SELECT record_class, snapshot FROM conditions.federation_outbox WHERE operation = 'create' ORDER BY seq`;
  expect(journal.filter((r) => r.record_class === "feature")).toHaveLength(3);
  const journalWaits = journal
    .filter((r) => r.record_class === "observation")
    .map((r) => r.snapshot);
  expect(journalWaits).toHaveLength(6);
  for (const row of journal) {
    expect(registry.validate(row.snapshot).ok).toBe(true);
    expect(row.snapshot.contentHash).toBe(contentHash(row.snapshot));
  }
  for (const feature of initial.records) {
    const matches = journal.filter(
      (r) => r.record_class === "feature" && r.snapshot.id === feature.id,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.snapshot.location).toEqual(feature.location);
    expect(feature.components.map((c: { key: string }) => c.key)).toEqual([
      "pl-ua-car",
      "pl-ua-dmc-gt7500",
    ]);
  }
  expect(journalWaits.map((r) => r.result.value.waitMinutes).sort((a, b) => a - b)).toEqual([
    0, 0, 120, 180, 600, 780,
  ]);
  expect(journalWaits.every((r) => r.freshness.expiresAt.startsWith("2026-11-09T20:"))).toBe(true);
  expect((await poll()).notDue).toBe(true);
  expect(requests).toBe(1);
  now = "2026-11-09T18:57:00Z";
  expect((await poll()).error).toBeUndefined();
  expect(validators.at(-1)).toBe('"granica-fixed"');
  const held =
    await db.sql`SELECT series_id, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`;
  now = "2026-11-09T19:28:00Z";
  expect((await poll(null, 304)).error).toBeUndefined();
  expect(
    await db.sql`SELECT series_id, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`,
  ).toEqual(held);
  now = "2026-11-09T19:59:00Z";

  for (const drift of [
    body.replace("Godzina aktualizacji:", "Missing:"),
    body.replaceAll("[h]", "[min]"),
    body.replace("obrazek  AUTOKARY", "obrazek VANS"),
    body.replaceAll(">7,5T DMC", "≤7,5T DMC"),
    body.replaceAll("19:00", "23:00"),
  ]) {
    // A fresh role state isolates each adverse acquisition from scheduler backoff.
    roles = createRoleState();
    expect((await poll(drift)).error).toBeDefined();
  }
  roles = createRoleState();
  expect(
    await db.sql`SELECT series_id, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`,
  ).toEqual(held);
  now = "2026-11-09T20:30:00Z";
  expect((await poll()).error).toBeUndefined();
  for (const canonical of ["", "&canonical=1"]) {
    expect((await get(`/observations/latest?property=border.wait${canonical}`)).records).toEqual(
      [],
    );
    const features = await get(
      `/features?kind=border_crossing&expand=latest,components${canonical}`,
    );
    expect(features.records).toHaveLength(3);
    expect(Object.values(features.latest).flat()).toEqual([]);
  }
  now = "2026-11-09T21:01:00Z";
  expect((await poll("unavailable", 500)).error).toBeDefined();
  expect((await get("/features?kind=border_crossing")).records).toHaveLength(3);
  const [persisted] =
    await db.sql`SELECT count(*)::int AS n FROM conditions.observation_latest WHERE source_id = ${feed.id}`;
  expect(persisted!.n).toBe(6);
});
