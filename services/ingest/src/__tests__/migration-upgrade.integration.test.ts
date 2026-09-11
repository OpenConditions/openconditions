import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMigrations } from "@openconditions/core/server";

let sql: postgres.Sql;
let url: string;
let stop: () => Promise<unknown>;
const folder = fileURLToPath(new URL("../../../../packages/core/drizzle/", import.meta.url));

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  stop = () => container.stop();
  url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
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
  await sql`INSERT INTO conditions.observations
    (id, source, source_format, domain, kind, status, geom, origin, data_updated_at, fetched_at)
    VALUES ('upgrade:preserved', 'upgrade', 'native', 'roads', 'event', 'active',
      ST_SetSRID(ST_MakePoint(5, 52), 4326), '{"kind":"feed","attribution":{"license":"CC0-1.0"}}', now(), now())`;

  await Promise.all([runMigrations(url), runMigrations(url), runMigrations(url)]);
  expect(
    await sql`SELECT id FROM conditions.observations WHERE id = 'upgrade:preserved'`
  ).toHaveLength(1);
  const [count] = await sql<{ n: number; distinct_n: number }[]>`
    SELECT count(*)::int AS n, count(DISTINCT created_at)::int AS distinct_n FROM drizzle.__drizzle_migrations_oc`;
  expect(count).toMatchObject({ n: journal.entries.length, distinct_n: journal.entries.length });
  const [functionBefore] = await sql<{ body: string }[]>`
    SELECT pg_get_functiondef('conditions.segment_flow(integer,integer,integer,json)'::regprocedure) AS body`;
  expect(functionBefore!.body).toContain("ST_AsMVT");
  expect(
    await sql`SELECT 1 FROM pg_trigger WHERE tgname = 'federation_outbox_capture_update'`
  ).toHaveLength(1);

  // A later deployed function must survive an older migrator starting again.
  await sql`CREATE OR REPLACE FUNCTION conditions.segment_flow(z integer, x integer, y integer, query_params json)
    RETURNS bytea LANGUAGE sql STABLE STRICT AS 'SELECT decode(''cafe'', ''hex'')'`;
  await runMigrations(url);
  const [after] = await sql<{ value: string }[]>`
    SELECT encode(conditions.segment_flow(0, 0, 0, '{}'::json), 'hex') AS value`;
  expect(after!.value).toBe("cafe");
}, 120_000);

it("serializes bootstrap and migrations on a fresh database", async () => {
  await sql`CREATE DATABASE conditions_fresh`;
  const freshUrl = new URL(url);
  freshUrl.pathname = "/conditions_fresh";
  await Promise.all(Array.from({ length: 3 }, () => runMigrations(freshUrl.toString())));
  const fresh = postgres(freshUrl.toString(), { max: 1 });
  try {
    const journal = JSON.parse(await readFile(path.join(folder, "meta/_journal.json"), "utf8"));
    const [count] =
      await fresh`SELECT count(*)::int AS n, count(DISTINCT created_at)::int AS distinct_n FROM drizzle.__drizzle_migrations_oc`;
    expect(count).toEqual({ n: journal.entries.length, distinct_n: journal.entries.length });
  } finally {
    await fresh.end();
  }
}, 120_000);
