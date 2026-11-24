import { runMigrations } from "@openconditions/core/server";
import { syncSources } from "@openconditions/storage";
import {
  CONTRIBUTIONS_ROLE,
  createTestDatabase,
  createTestRole,
  type TestDatabase,
  type TestRole,
  TILES_OWNER_ROLE,
} from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The custom migration grants OpenMapX's tile role and the contributions
 * service's role exactly what they use, by name, to roles that exist when it
 * runs. The integration run's server has both roles, created after the
 * template was migrated.
 */

/** Each privilege a role holds in the schema conditions, as `<kind> <object> <privilege>`. */
async function privileges(sql: postgres.Sql, role: string): Promise<string[]> {
  const rows = await sql<{ grant: string }[]>`
    SELECT concat_ws(' ', kind, name, privilege) AS grant FROM (
      SELECT 'schema' AS kind, n.nspname::text AS name, a.privilege_type AS privilege, a.grantee
        FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
        WHERE n.nspname = 'conditions'
      UNION ALL
      SELECT CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END, c.relname::text,
             a.privilege_type, a.grantee
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE c.relnamespace = 'conditions'::regnamespace
      UNION ALL
      SELECT 'column', c.relname || '.' || att.attname, a.privilege_type, a.grantee
        FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid
        CROSS JOIN LATERAL aclexplode(att.attacl) a
        WHERE c.relnamespace = 'conditions'::regnamespace
      UNION ALL
      SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
             a.privilege_type, a.grantee
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE p.pronamespace = 'conditions'::regnamespace
    ) granted
    WHERE grantee = (SELECT oid FROM pg_roles WHERE rolname = ${role})`;
  return rows.map((r) => r.grant).sort();
}

const TILE_GRANTS = [
  "function flow_osm_credit() EXECUTE",
  "function flow_public_licenses(licenses text[]) EXECUTE",
  "function segment_flow(z integer, x integer, y integer, query_params json) EXECUTE",
  "schema conditions USAGE",
  "table public_license_policy SELECT",
  "table road_segment SELECT",
  "table segment_speed SELECT",
  "table source SELECT",
].sort();

/** What contributions-api's queries use; its flows test runs them with only these. */
const CONTRIBUTIONS_GRANTS = [
  "schema conditions USAGE",
  "sequence federation_outbox_seq_seq USAGE",
  "sequence observation_latest_series_id_seq USAGE",
  "sequence report_evidence_id_seq USAGE",
  "sequence report_refusal_id_seq USAGE",
  ...[
    "__drizzle_migrations",
    "feature",
    "feature_canonical",
    "feature_component",
    "federation_subscription",
    "observation",
    "observation_rollup_progress",
    "offer",
    "source",
    "source_poll_attempt",
    "source_status",
  ].map((table) => `table ${table} SELECT`),
  "table situation_revision INSERT",
  ...[
    "contributor_receipt",
    "federation_outbox",
    "issuer_key",
    "report_evidence",
    "spent_token",
    "sub_claim",
  ].flatMap((table) => [`table ${table} INSERT`, `table ${table} SELECT`]),
  "table record_relation DELETE",
  "table record_relation SELECT",
  ...["report_refusal", "situation_effect"].flatMap((table) =>
    ["DELETE", "INSERT", "SELECT"].map((p) => `table ${table} ${p}`),
  ),
  ...["binding_queue", "reporter", "situation", "token_quota"].flatMap((table) =>
    ["INSERT", "SELECT", "UPDATE"].map((p) => `table ${table} ${p}`),
  ),
  ...["block_list", "observation_latest"].flatMap((table) =>
    ["DELETE", "INSERT", "SELECT", "UPDATE"].map((p) => `table ${table} ${p}`),
  ),
].sort();

const databases: TestDatabase[] = [];
const roles: TestRole[] = [];
const clients: postgres.Sql[] = [];

afterAll(async () => {
  for (const client of clients.splice(0)) await client.end();
  for (const db of databases.splice(0)) await db.close();
  for (const role of roles.splice(0)) await role.drop();
}, 30_000);

/** A login role on `db`, kept until the suite ends. */
async function login(db: TestDatabase): Promise<{ role: TestRole; sql: postgres.Sql }> {
  const role = await createTestRole(db);
  roles.push(role);
  const sql = postgres(role.url, { max: 1, onnotice: () => {} });
  clients.push(sql);
  return { role, sql };
}

/** An empty database migrated as the ingest service's role does, which owns `conditions`. */
async function migratedAsIngest(): Promise<{ db: TestDatabase; ingest: postgres.Sql }> {
  const db = await createTestDatabase({ empty: true });
  databases.push(db);
  const { role, sql } = await login(db);
  await db.sql`CREATE EXTENSION postgis`;
  const [database] = await db.sql<{ name: string }[]>`SELECT current_database() AS name`;
  await db.sql.unsafe(`GRANT CREATE ON DATABASE "${database!.name}" TO "${role.name}"`);
  await runMigrations(role.url);
  return { db, ingest: sql };
}

describe("roles created before the first migrate", () => {
  let db: TestDatabase;
  let ingest: postgres.Sql;

  beforeAll(async () => {
    ({ db, ingest } = await migratedAsIngest());
  }, 120_000);

  it("receive exactly their grants", async () => {
    expect(await privileges(db.sql, TILES_OWNER_ROLE)).toEqual(TILE_GRANTS);
    expect(await privileges(db.sql, CONTRIBUTIONS_ROLE)).toEqual(CONTRIBUTIONS_GRANTS);
  });

  it("segment_flow renders as a role holding only the tile grants", async () => {
    // A segment with a measurement under a public licence, written as ingest writes it.
    await syncSources(ingest, []);
    await ingest`
      INSERT INTO conditions.road_segment
        (segment_id, way_id, dir, geom, highway, length_m, min_zoom, free_flow_kph, computed_at)
      VALUES ('500:f', 500, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(5.1 52.1, 5.11 52.1)'), 4326),
        'motorway', 1000, 5, 100, now())`;
    await ingest`
      INSERT INTO conditions.segment_speed
        (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, source_tier,
         contributing, is_estimated, observed_at, updated_at, permission_licenses)
      VALUES ('500:f', 50, 100, 0.5, 'heavy', 'measured', 'sensor', ARRAY['test-source'], false,
        now(), now(), ARRAY['CC0-1.0'])`;
    // As OpenMapX serves the tile: Martin's login may call only a function in
    // the schema tiles, which runs as the tile owner and calls segment_flow.
    // PostGIS stays in public here, as in the plain image.
    const martin = await login(db);
    await db.sql.unsafe(`
      CREATE SCHEMA tiles;
      GRANT USAGE ON SCHEMA tiles TO "${martin.role.name}", ${TILES_OWNER_ROLE};
      CREATE FUNCTION tiles.segment_flow(z integer, x integer, y integer, query_params json)
        RETURNS bytea LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
      AS $$ BEGIN RETURN conditions.segment_flow(z, x, y, query_params); END; $$;
      ALTER FUNCTION tiles.segment_flow(integer, integer, integer, json) OWNER TO ${TILES_OWNER_ROLE};
      REVOKE ALL ON FUNCTION tiles.segment_flow(integer, integer, integer, json) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION tiles.segment_flow(integer, integer, integer, json)
        TO "${martin.role.name}";
    `);
    const [served] = await martin.sql<{ tile: Buffer }[]>`
      SELECT tiles.segment_flow(8, 131, 84, '{}') AS tile`;
    const [direct] = await db.sql<{ tile: Buffer }[]>`
      SELECT conditions.segment_flow(8, 131, 84, '{}') AS tile`;
    expect(direct!.tile.includes("speed_ratio")).toBe(true);
    expect(served!.tile).toEqual(direct!.tile);

    // Nothing outside the contract is readable to the tile owner.
    await expect(
      db.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${TILES_OWNER_ROLE}`);
        await tx`SELECT count(*) FROM conditions.reporter`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  }, 60_000);
});

it("a role created after the migrate holds no grants, also after the next migrate", async () => {
  // The template was migrated before the roles existed; a migrate with
  // nothing pending grants nothing either.
  const db = await createTestDatabase();
  databases.push(db);
  expect(await privileges(db.sql, TILES_OWNER_ROLE)).toEqual([]);
  expect(await privileges(db.sql, CONTRIBUTIONS_ROLE)).toEqual([]);
  await runMigrations(db.url);
  expect(await privileges(db.sql, TILES_OWNER_ROLE)).toEqual([]);
  expect(await privileges(db.sql, CONTRIBUTIONS_ROLE)).toEqual([]);
}, 60_000);
