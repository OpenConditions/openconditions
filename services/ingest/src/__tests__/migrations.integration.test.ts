import { readFile } from "node:fs/promises";
import { runMigrations } from "@openconditions/core/server";
import { createTestDatabase } from "@openconditions/test-database";
import { expect, it } from "vitest";

const folder = new URL("../../../../packages/core/drizzle/", import.meta.url);

async function journalLength(): Promise<number> {
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", folder), "utf8")) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

/** The body a function of the custom migration is written with, between its dollar quotes. */
async function customFunctionBody(name: string): Promise<string> {
  const sql = await readFile(new URL("0001_database_objects.sql", folder), "utf8");
  const body = new RegExp(`FUNCTION "?conditions"?\\.${name}\\([^$]*\\$\\$([\\s\\S]*?)\\$\\$`).exec(
    sql,
  )?.[1];
  if (body === undefined) throw new Error(`no function ${name} in the custom migration`);
  return body;
}

it("serializes bootstrap and migrations on a fresh database", async () => {
  const fresh = await createTestDatabase({ empty: true, pool: { max: 1 } });
  try {
    await Promise.all(Array.from({ length: 3 }, () => runMigrations(fresh.url)));
    const entries = await journalLength();
    const [count] =
      await fresh.sql`SELECT count(*)::int AS n, count(DISTINCT created_at)::int AS distinct_n FROM drizzle.__drizzle_migrations_oc`;
    expect(count).toEqual({ n: entries, distinct_n: entries });
  } finally {
    await fresh.close();
  }
}, 120_000);

it("after a fresh migrate, segment_flow, the helper functions and the four triggers exist", async () => {
  const db = await createTestDatabase();
  try {
    const functions = await db.sql<{ name: string }[]>`
      SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'conditions' ORDER BY 1`;
    expect(functions.map((f) => f.name)).toEqual([
      "federation_is_own",
      "federation_journal_tombstone",
      "federation_may_carry",
      "federation_observation_capture",
      "federation_record_capture",
      "federation_situation_capture",
      "federation_situation_priority",
      "federation_situation_snapshot",
      "federation_wants",
      "federation_was_shared",
      "flow_credit",
      "flow_credit_licensing",
      "flow_credit_union",
      "flow_field_sources",
      "flow_known_fields",
      "flow_native_field_sources",
      "flow_osm_credit",
      "flow_permission_union",
      "flow_public_licenses",
      "flow_receipt_permissions",
      "flow_source_credit",
      "observation_fusion_provenance",
      "observation_record",
      "segment_flow",
    ]);
    // OpenMapX renders traffic tiles through this signature.
    const [tile] = await db.sql<{ body: string }[]>`
      SELECT pg_get_functiondef('conditions.segment_flow(integer,integer,integer,json)'::regprocedure) AS body`;
    expect(tile!.body).toContain(await customFunctionBody("segment_flow"));
    const capture = await db.sql<{ relation: string; fn: string }[]>`
      SELECT tgrelid::regclass::text AS relation, tgfoid::regproc::text AS fn FROM pg_trigger
      WHERE tgname = 'federation_capture' ORDER BY 1`;
    expect(capture).toEqual([
      { relation: "conditions.feature", fn: "conditions.federation_record_capture" },
      {
        relation: "conditions.observation_latest",
        fn: "conditions.federation_observation_capture",
      },
      { relation: "conditions.offer", fn: "conditions.federation_record_capture" },
      { relation: "conditions.situation", fn: "conditions.federation_situation_capture" },
    ]);
    const [observation] = await db.sql<{ kind: string; strategy: string }[]>`
      SELECT c.relkind AS kind, p.partstrat AS strategy FROM pg_class c
      JOIN pg_partitioned_table p ON p.partrelid = c.oid
      WHERE c.oid = 'conditions.observation'::regclass`;
    expect(observation).toEqual({ kind: "p", strategy: "l" });
    expect(
      await db.sql`SELECT conname FROM pg_constraint
        WHERE conrelid = 'conditions.geonet_coverage'::regclass AND contype = 'c'`,
    ).toEqual([{ conname: "geonet_coverage_order" }]);
    expect(await db.sql`SELECT count(*)::int AS n FROM conditions.federation_journal`).toEqual([
      { n: 1 },
    ]);
  } finally {
    await db.close();
  }
});

it("observation_latest keeps its storage parameters", async () => {
  const db = await createTestDatabase();
  try {
    const [table] = await db.sql<{ options: string[] }[]>`
      SELECT reloptions AS options FROM pg_class WHERE oid = 'conditions.observation_latest'::regclass`;
    expect([...table!.options].sort()).toEqual([
      "autovacuum_analyze_scale_factor=2",
      "autovacuum_vacuum_scale_factor=0.5",
      "fillfactor=50",
      "toast_tuple_target=1200",
    ]);
    const columns = await db.sql<{ name: string; storage: string }[]>`
      SELECT attname AS name, attstorage AS storage FROM pg_attribute
      WHERE attrelid = 'conditions.observation_latest'::regclass AND attname IN ('template', 'reading')
      ORDER BY 1`;
    expect(columns).toEqual([
      { name: "reading", storage: "m" },
      { name: "template", storage: "e" },
    ]);
  } finally {
    await db.close();
  }
});

it("a second migrate leaves a later deployed function in place", async () => {
  const db = await createTestDatabase();
  try {
    await db.sql`CREATE OR REPLACE FUNCTION conditions.segment_flow(z integer, x integer, y integer, query_params json)
      RETURNS bytea LANGUAGE sql STABLE STRICT AS 'SELECT decode(''cafe'', ''hex'')'`;
    await runMigrations(db.url);
    const [after] = await db.sql<{ value: string }[]>`
      SELECT encode(conditions.segment_flow(0, 0, 0, '{}'::json), 'hex') AS value`;
    expect(after!.value).toBe("cafe");
  } finally {
    await db.close();
  }
});
