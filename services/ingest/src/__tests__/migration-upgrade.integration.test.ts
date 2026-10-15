import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "@openconditions/core/server";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

let db: TestDatabase;
let sql: postgres.Sql;
let url: string;
const folder = fileURLToPath(new URL("../../../../packages/core/drizzle/", import.meta.url));

beforeAll(async () => {
  db = await createTestDatabase({ empty: true, pool: { max: 3 } });
  sql = db.sql;
  url = db.url;
});

afterAll(async () => {
  await db?.close();
});

it("upgrades a populated previous schema concurrently and never reapplies versioned function SQL", async () => {
  const journal = JSON.parse(await readFile(path.join(folder, "meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  // Install exactly the historical schema and migration journal through 0027.
  // No current schema bootstrap or CREATE TABLE approximation hides upgrade gaps.
  await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
  await sql`CREATE SCHEMA conditions`;
  await sql`CREATE SCHEMA drizzle`;
  await sql`CREATE TABLE drizzle.__drizzle_migrations_oc (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
  await sql.begin(async (tx) => {
    for (const entry of journal.entries.filter((entry) => entry.idx <= 27)) {
      const migration = await readFile(path.join(folder, `${entry.tag}.sql`), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.unsafe(statement);
      }
      await tx`INSERT INTO drizzle.__drizzle_migrations_oc (hash, created_at)
        VALUES (${createHash("sha256").update(migration).digest("hex")}, ${entry.when})`;
    }
  });
  await sql`INSERT INTO conditions.osm_road (way_id, geom, highway, region, imported_at)
    VALUES (4711, ST_SetSRID(ST_MakeLine(ST_MakePoint(5, 52), ST_MakePoint(5.01, 52)), 4326),
      'primary', 'nl', now())`;
  await sql`INSERT INTO conditions.observations
    (id, source, source_format, domain, kind, status, geom, origin, data_updated_at, fetched_at)
    VALUES ('upgrade:legacy', 'upgrade', 'native', 'roads', 'measurement', 'active',
      ST_SetSRID(ST_MakePoint(5, 52), 4326), '{"kind":"feed","attribution":{"license":"CC0-1.0"}}', now(), now())`;
  await sql`INSERT INTO conditions.sensor_baseline
    (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
    VALUES ('upgrade:s1', 'upgrade', -1, -1, 100, 'derived', 40, now())`;
  await sql`INSERT INTO conditions.sensor_segment
    (sensor_key, segment_id, fraction, offset_m, matched_at) VALUES ('upgrade:s1', '4711:f', 0.5, 3, now())`;

  await Promise.all([runMigrations(url), runMigrations(url), runMigrations(url)]);
  expect(await sql`SELECT way_id FROM conditions.osm_road WHERE way_id = 4711`).toHaveLength(1);
  // The legacy flow store is gone; derived baselines and snaps are recomputed under the new keys.
  expect(await sql`SELECT to_regclass('conditions.observations') AS t`).toEqual([{ t: null }]);
  expect(await sql`SELECT subject_key FROM conditions.sensor_baseline`).toEqual([]);
  expect(await sql`SELECT subject_key FROM conditions.sensor_segment`).toEqual([]);
  const [count] = await sql<{ n: number; distinct_n: number }[]>`
    SELECT count(*)::int AS n, count(DISTINCT created_at)::int AS distinct_n FROM drizzle.__drizzle_migrations_oc`;
  expect(count).toMatchObject({ n: journal.entries.length, distinct_n: journal.entries.length });
  const [functionBefore] = await sql<{ body: string }[]>`
    SELECT pg_get_functiondef('conditions.segment_flow(integer,integer,integer,json)'::regprocedure) AS body`;
  expect(functionBefore!.body).toContain("ST_AsMVT");
  // The outbox journals the record tables.
  const capture = await sql<{ relation: string }[]>`
    SELECT tgrelid::regclass::text AS relation FROM pg_trigger
    WHERE tgname = 'federation_capture' ORDER BY 1`;
  expect(capture.map((t) => t.relation)).toEqual([
    "conditions.feature",
    "conditions.observation_latest",
    "conditions.offer",
    "conditions.situation",
  ]);

  // A later deployed function must survive an older migrator starting again.
  await sql`CREATE OR REPLACE FUNCTION conditions.segment_flow(z integer, x integer, y integer, query_params json)
    RETURNS bytea LANGUAGE sql STABLE STRICT AS 'SELECT decode(''cafe'', ''hex'')'`;
  await runMigrations(url);
  const [after] = await sql<{ value: string }[]>`
    SELECT encode(conditions.segment_flow(0, 0, 0, '{}'::json), 'hex') AS value`;
  expect(after!.value).toBe("cafe");
}, 120_000);

it("serializes bootstrap and migrations on a fresh database", async () => {
  const fresh = await createTestDatabase({ empty: true, pool: { max: 1 } });
  try {
    await Promise.all(Array.from({ length: 3 }, () => runMigrations(fresh.url)));
    const journal = JSON.parse(await readFile(path.join(folder, "meta/_journal.json"), "utf8"));
    const [count] =
      await fresh.sql`SELECT count(*)::int AS n, count(DISTINCT created_at)::int AS distinct_n FROM drizzle.__drizzle_migrations_oc`;
    expect(count).toEqual({ n: journal.entries.length, distinct_n: journal.entries.length });
  } finally {
    await fresh.close();
  }
}, 120_000);
