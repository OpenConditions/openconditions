import { readFileSync } from "node:fs";
import { productionRegistry } from "@openconditions/model-registry";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";

const source = repoFeed("ca-bc-drivebc-cameras");
const feed = {
  ...source,
  disabled: undefined,
  snapshot: { ...source.snapshot!, qualification: "qualified" as const, minimumRecords: 1 },
};
const bytes = readFileSync(
  new URL("../../../../packages/cameras/src/__tests__/fixtures/ca-bc-drivebc.csv", import.meta.url),
);
let db: TestDatabase;
let app: FastifyInstance;
const now = "2026-11-07T01:00:00Z";
const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const serve = (body: Buffer) =>
  (async () =>
    new Response(new Uint8Array(body), {
      headers: { "content-type": "text/csv" },
    })) as typeof fetch;
beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [feed]);
  app = Fastify();
  registerScope(app, "test-token");
  registerApiRoutes(app, db.sql, {
    catalog: { sources: [feed] },
    registry: productionRegistry(),
    now: () => new Date(now),
  });
  await app.ready();
}, 120000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

test("actual pipeline publishes public view credits and keeps last good inventory on qualification failure", async () => {
  const deps = { sql: db.sql, lookup, now: () => now, fetch: serve(bytes) };
  const first = await runSource(feed, deps);
  expect(first.error).toBeUndefined();
  const response = await app.inject({
    url: "/features?kind=camera&expand=components,latest&bbox=-140,48,-114,61",
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.body).toContain("https://www.drivebc.ca/cameras/");
  expect(response.body).toContain("camera.image");
  expect(response.body).toContain('"status":"unknown"');
  expect(response.body).not.toContain('"imageAt"');
  const canonical = await app.inject({
    url: "/features?kind=camera&canonical=1&expand=components,latest&bbox=-140,48,-114,61",
  });
  expect(canonical.statusCode).toBe(200);
  expect(canonical.body).toContain('"credit"');
  expect(canonical.body).toContain("https://www.drivebc.ca/cameras/");
  expect(canonical.body).toContain('"publisher"');
  const sources = await app.inject({ url: "/sources" });
  expect(sources.statusCode).toBe(200);
  expect(sources.body).toContain("LicenseRef-OGL-BC");
  const held =
    await db.sql`SELECT id, revision, content_hash FROM conditions.feature WHERE source_id = ${feed.id} ORDER BY id`;
  const pending = await runSource({ ...feed, snapshot: source.snapshot }, deps);
  expect(pending.error).toMatch(/qualification pending/);
  const empty = await runSource(feed, { ...deps, fetch: serve(Buffer.from("id,cam_group\n")) });
  expect(empty.error).toBeDefined();
  const truncated = await runSource(feed, {
    ...deps,
    fetch: serve(Buffer.from('id,cam_group\n1,"unterminated')),
  });
  expect(truncated.error).toMatch(/CSV/);
  const unavailable = await runSource(feed, {
    ...deps,
    fetch: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
  });
  expect(unavailable.error).toBeDefined();
  const after = await app.inject({
    url: "/features?kind=camera&expand=components,latest&bbox=-140,48,-114,61",
  });
  expect(after.statusCode).toBe(200);
  expect(
    await db.sql`SELECT id, revision, content_hash FROM conditions.feature WHERE source_id = ${feed.id} ORDER BY id`,
  ).toEqual(held);
  const shortened = Buffer.from(
    bytes
      .toString("utf8")
      .split("\n")
      .filter((line) => line.split(",")[1] !== "520")
      .join("\n"),
  );
  const withdrawn = await runSource(feed, { ...deps, fetch: serve(shortened) });
  expect(withdrawn.error).toBeUndefined();
  const rows =
    await db.sql`SELECT tombstone_reason FROM conditions.feature WHERE source_id = ${feed.id} AND id = 'oc:feature:ca-bc-drivebc-cameras:520'`;
  expect(rows[0]?.tombstone_reason).toBe("withdrawn");
});
