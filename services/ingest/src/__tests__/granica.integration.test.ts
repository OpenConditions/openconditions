import { readFileSync } from "node:fs";
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
    "../../../../packages/border/src/__tests__/fixtures/granica-2026-11-08.html.txt",
    import.meta.url,
  ),
  "utf8",
);
let db: TestDatabase;
let now = "2026-11-08T07:22:57Z";
const app = Fastify();
const roles = createRoleState();
let requests = 0;
const validators: (string | null)[] = [];
const poll = (payload = body, status = 200) =>
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
  const initial = await get("/features?kind=border_crossing&expand=latest,components");
  expect(initial.records).toHaveLength(3);
  expect(Object.values(initial.latest).flat()).toHaveLength(6);
  expect(JSON.stringify(initial)).toContain("Ministerstwo Finansów");
  expect(JSON.stringify(initial)).toContain("CC0-1.0");
  expect(JSON.stringify(initial)).toContain("maximumPermissibleGrossMass");
  expect((await poll()).notDue).toBe(true);
  expect(requests).toBe(1);
  now = "2026-11-08T08:00:00Z";
  expect((await poll()).error).toBeUndefined();
  expect(validators.at(-1)).toBe('"granica-fixed"');
  const held =
    await db.sql`SELECT series_id, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`;
  now = "2026-11-08T08:31:00Z";
  // Synthetic older cached publication, independent of retrieval success/time.
  expect(
    (await poll(body.replaceAll("08:17", "07:17").replaceAll("08:15", "07:15"))).error,
  ).toBeUndefined();
  expect(
    await db.sql`SELECT series_id, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`,
  ).toEqual(held);
  now = "2026-11-08T09:02:00Z";

  expect((await poll(body.replace("Godzina aktualizacji:", "Missing:"))).error).toBeDefined();
  expect(
    await db.sql`SELECT series_id, reading FROM conditions.observation_latest WHERE source_id = ${feed.id} ORDER BY series_id`,
  ).toEqual(held);
  now = "2026-11-08T09:33:00Z";
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
  now = "2026-11-08T10:04:00Z";
  expect((await poll("unavailable", 500)).error).toBeDefined();
  expect((await get("/features?kind=border_crossing")).records).toHaveLength(3);
  const [persisted] =
    await db.sql`SELECT count(*)::int AS n FROM conditions.observation_latest WHERE source_id = ${feed.id}`;
  expect(persisted!.n).toBe(6);
});
