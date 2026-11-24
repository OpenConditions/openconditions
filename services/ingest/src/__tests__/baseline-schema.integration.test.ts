import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: TestDatabase;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 3 } });
  sql = db.sql;
});

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("baseline schema", () => {
  it("holds no legacy observation or speed-sample tables", async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'conditions' AND table_name IN
         ('observations', 'sensor_speed_sample', 'sensor_speed_hourly', 'speed_rollup_progress')`;
    expect(rows).toEqual([]);
  }, 30_000);

  it("upserts sensor_baseline on its composite PK", async () => {
    await sql`
      INSERT INTO conditions.sensor_baseline
        (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('feature:oc:feature:src:1', 'src', -1, -1, 100.0, 'derived', 42, now())`;
    await sql`
      INSERT INTO conditions.sensor_baseline
        (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('feature:oc:feature:src:1', 'src', -1, -1, 110.0, 'derived', 50, now())
      ON CONFLICT (subject_key, dow_bucket, tod_bucket, method)
      DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, sample_count = EXCLUDED.sample_count`;
    const rows = await sql<{ free_flow_kph: number; n: number }[]>`
      SELECT free_flow_kph, sample_count AS n FROM conditions.sensor_baseline
      WHERE subject_key = 'feature:oc:feature:src:1' AND method = 'derived'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.free_flow_kph).toBe(110);
  }, 30_000);
});

/**
 * Objects not named for their table and columns alone. A partial index whose
 * predicate selects rows by more than whether a column is null names that
 * subset, since its columns alone would read as an index over the whole
 * table; so does an index in another collation than its column's; an index on
 * an expression has no columns to name; and a column list that would pass
 * PostgreSQL's 63-byte identifier limit is shortened.
 */
const NAMED_BY_PURPOSE: Record<string, string> = {
  federation_subscription_target_key: "federation_subscription",
  feature_external_ids_idx: "feature",
  feature_id_bytes_idx: "feature",
  feature_id_rights_revoked_idx: "feature",
  observation_latest_series_key: "observation_latest",
  observation_latest_value_money_fuel_price_idx: "observation_latest",
  offer_id_bytes_idx: "offer",
  offer_id_rights_revoked_idx: "offer",
  report_evidence_merged_idx: "report_evidence",
  situation_evidence_state_crowd_idx: "situation",
  situation_id_bytes_idx: "situation",
  situation_id_rights_revoked_idx: "situation",
};

const NAME_SUFFIX: Record<string, string> = { p: "pkey", u: "key", f: "fkey", U: "key", i: "idx" };

/** The CHECKs of closed value sets, by name: each must name every value it admits. */
const VOCABULARY_CHECKS: Record<string, { table: string; values: string[] }> = {
  segment_observation_los_check: {
    table: "segment_observation",
    values: ["free_flow", "heavy", "queuing", "stationary", "blocked", "unknown"],
  },
  segment_speed_los_check: {
    table: "segment_speed",
    values: ["free_flow", "heavy", "queuing", "stationary", "blocked", "unknown"],
  },
  segment_speed_confidence_check: { table: "segment_speed", values: ["measured", "estimated"] },
  record_binding_status_check: {
    table: "record_binding",
    values: [
      "exact",
      "likely",
      "ambiguous",
      "unresolved",
      "no_coverage",
      "not_applicable",
      "obsolete",
    ],
  },
  record_binding_direction_mode_check: {
    table: "record_binding",
    values: ["single", "both", "unknown"],
  },
  federation_subscription_status_check: {
    table: "federation_subscription",
    values: ["active", "push_disabled"],
  },
  federation_tombstone_reason_check: {
    table: "federation_tombstone",
    values: ["expired", "withdrawn", "superseded", "cancelled", "rights_revoked", "rejected"],
  },
};

/** Fixed-width columns first, widest alignment first, so no row pays alignment padding. */
const COLUMN_ORDER: Record<string, string[]> = {
  observation: [
    "series_id",
    "phenomenon_start",
    "issued_at",
    "fetched_at",
    "recorded_at",
    "phenomenon_end",
    "result_time",
    "valid_until",
    "value_num",
    "fetch_id",
    "retention_days",
    "raw_part",
    "temporality",
    "aggregation",
    "value_money",
    "value_text",
    "value_json",
    "quality",
    "baseline",
    "extra",
  ],
  observation_rollup_hourly: [
    "series_id",
    "hour_utc",
    "min",
    "max",
    "mean",
    "sample_count",
    "lineage_complete",
    "contributor_receipt_ids",
    "bins",
    "counts",
  ],
  observation_latest: [
    "series_id",
    "effective_from",
    "since_at",
    "updated_at",
    "effective_until",
    "expires_at",
    "value_num",
    "confidence_score",
    "corroborations",
    "retention_days",
    "fused_public",
    "subject_key",
    "property",
    "qualifier_key",
    "source_id",
    "subject_kind",
    "access_mode",
    "result_type",
    "template_hash",
    "feature_id",
    "component_key",
    "situation_id",
    "crowd_record_id",
    "contributor_receipt_id",
    "value_money",
    "value_text",
    "unit",
    "currency",
    "fused_from",
    "fused_sources",
    "evidence_state",
    "geom",
    "reading",
    "template",
  ],
};

describe("schema conventions", () => {
  it("names every constraint and index after its table and columns", async () => {
    // Constraints, then the indexes that back no constraint, of the service's
    // own tables (drizzle's migration journal is drizzle's). NOT NULL
    // constraints (contype 'n') are left out: PostgreSQL names them itself.
    const objects = await sql<
      { table: string; name: string; kind: string; columns: string[]; subset: boolean }[]
    >`
      WITH owned AS (
        SELECT r.oid, r.relname FROM pg_class r
        JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE r.relkind IN ('r', 'p') AND NOT r.relispartition AND n.nspname = 'conditions'
          AND r.relname <> '__drizzle_migrations')
      SELECT o.relname AS table, c.conname AS name, c.contype::text AS kind,
        array(
          SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          ORDER BY k.position
        ) AS columns,
        false AS subset
      FROM pg_constraint c JOIN owned o ON o.oid = c.conrelid
      WHERE c.contype IN ('p', 'u', 'f', 'c', 'x') AND c.conparentid = 0
      UNION ALL
      SELECT o.relname, ix.relname, CASE WHEN i.indisunique THEN 'U' ELSE 'i' END,
        array(
          SELECT coalesce(a.attname::text, '')
          FROM unnest((i.indkey::int2[])[0:i.indnkeyatts - 1]) WITH ORDINALITY AS k(attnum, position)
          LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          ORDER BY k.position
        ),
        (i.indpred IS NOT NULL
          AND pg_get_expr(i.indpred, i.indrelid) !~ '^\\(?[a-z_]+ IS (NOT )?NULL\\)?$')
          OR EXISTS (
            SELECT FROM unnest(i.indkey::int2[], i.indcollation::oid[]) AS k(attnum, coll)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
            WHERE k.coll <> 0 AND k.coll <> a.attcollation)
      FROM pg_index i JOIN owned o ON o.oid = i.indrelid
      JOIN pg_class ix ON ix.oid = i.indexrelid
      WHERE NOT EXISTS (SELECT FROM pg_constraint c WHERE c.conindid = i.indexrelid
        AND c.contype IN ('p', 'u', 'x'))
      ORDER BY 1, 2`;
    expect(objects.map((row) => row.table)).toEqual(
      expect.arrayContaining(["observation", "observation_latest", "situation"]),
    );
    const misnamed: string[] = [];
    const byPurpose: string[] = [];
    for (const { table, name, kind, columns, subset } of objects) {
      if (kind === "c") {
        if (!new RegExp(`^${table}_[a-z0-9_]+_check$`).test(name)) misnamed.push(name);
        continue;
      }
      const suffix = NAME_SUFFIX[kind];
      const conventional =
        kind === "p" ? `${table}_pkey` : `${table}_${columns.join("_")}_${suffix}`;
      if (subset || columns.includes("") || conventional.length > 63) {
        byPurpose.push(name);
        const ok =
          NAMED_BY_PURPOSE[name] === table &&
          name.startsWith(`${table}_`) &&
          name.endsWith(`_${suffix}`) &&
          name.length <= 63;
        if (!ok) misnamed.push(`${name} (named by purpose)`);
      } else if (name !== conventional) misnamed.push(`${name} -> ${conventional}`);
    }
    expect(misnamed).toEqual([]);
    expect(byPurpose.sort()).toEqual(Object.keys(NAMED_BY_PURPOSE).sort());
  }, 30_000);

  it("generates ids by identity, never by a serial's sequence default", async () => {
    const serial = await sql<{ column: string }[]>`
      SELECT table_name || '.' || column_name AS column FROM information_schema.columns
       WHERE table_schema = 'conditions' AND table_name <> '__drizzle_migrations'
         AND column_default LIKE 'nextval(%'
       ORDER BY 1`;
    expect(serial).toEqual([]);
    const identity = await sql<{ column: string; generation: string }[]>`
      SELECT table_name || '.' || column_name AS column, identity_generation AS generation
        FROM information_schema.columns
       WHERE table_schema = 'conditions' AND is_identity = 'YES'
       ORDER BY 1`;
    expect(identity).toEqual(
      [
        "federation_outbox.seq",
        "observation_latest.series_id",
        "report_evidence.id",
        "report_refusal.id",
        "source_poll_attempt.id",
      ].map((column) => ({ column, generation: "BY DEFAULT" })),
    );
  }, 30_000);

  it("checks every closed value set it stores", async () => {
    const checks = await sql<{ name: string; table: string; definition: string }[]>`
      SELECT c.conname AS name, r.relname AS table, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = 'conditions' AND c.contype = 'c' AND c.conname = ANY(${Object.keys(VOCABULARY_CHECKS)})`;
    expect(checks.map((c) => c.name).sort()).toEqual(Object.keys(VOCABULARY_CHECKS).sort());
    for (const check of checks) {
      const expected = VOCABULARY_CHECKS[check.name]!;
      expect(check.table).toBe(expected.table);
      const admitted = [...check.definition.matchAll(/'([^']*)'::text/g)].map((m) => m[1]);
      expect(admitted.sort(), check.name).toEqual([...expected.values].sort());
    }
    const [coverage] = await sql<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = 'geonet_coverage_order_check'`;
    expect(coverage?.definition).toBe("CHECK ((covered_from < covered_until))");
  }, 30_000);

  it("stores fixed-width columns first in the observation tables", async () => {
    const rows = await sql<{ table: string; columns: string[] }[]>`
      SELECT r.relname AS table, array_agg(a.attname::text ORDER BY a.attnum) AS columns
        FROM pg_attribute a
        JOIN pg_class r ON r.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = 'conditions' AND r.relname = ANY(${Object.keys(COLUMN_ORDER)})
         AND a.attnum > 0 AND NOT a.attisdropped
       GROUP BY r.relname`;
    expect(Object.fromEntries(rows.map((r) => [r.table, r.columns]))).toEqual(COLUMN_ORDER);
  }, 30_000);

  it("keeps no index that a unique constraint's leading columns already serve", async () => {
    const duplicates = await sql<{ table: string; index: string; unique: string }[]>`
      SELECT t.relname AS table, ix.relname AS index, ux.relname AS unique
        FROM pg_index i
        JOIN pg_class ix ON ix.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_index u ON u.indrelid = i.indrelid AND u.indisunique
          AND u.indexrelid <> i.indexrelid AND u.indpred IS NULL AND u.indexprs IS NULL
        JOIN pg_class ux ON ux.oid = u.indexrelid
       WHERE n.nspname = 'conditions'
         AND NOT i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
         AND i.indnatts <= u.indnatts
         AND (u.indkey::int2[])[0:i.indnatts - 1] = (i.indkey::int2[])[0:i.indnatts - 1]
         AND (u.indcollation::oid[])[0:i.indnatts - 1] = (i.indcollation::oid[])[0:i.indnatts - 1]
       ORDER BY 1, 2`;
    expect(duplicates).toEqual([]);
    // Nothing reads segment speeds by level of service, and a rebuild rewrites them all.
    const losIndexes = await sql`
      SELECT 1 FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indrelid = 'conditions.segment_speed'::regclass AND a.attname = 'los'`;
    expect(losIndexes).toEqual([]);
  }, 30_000);

  it("indexes every foreign key column", async () => {
    const unindexed = await sql<{ constraint: string }[]>`
      SELECT c.conname AS constraint FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'conditions' AND c.contype = 'f' AND c.conparentid = 0
         AND NOT EXISTS (SELECT FROM pg_index i WHERE i.indrelid = c.conrelid
           AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)
       ORDER BY 1`;
    expect(unindexed).toEqual([]);
  }, 30_000);

  it("indexes what the records sweep looks up on features and offers", async () => {
    const indexes = await sql<{ name: string; definition: string }[]>`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes
       WHERE schemaname = 'conditions' AND tablename IN ('feature', 'offer')
         AND indexname ~ '_(expires|tombstoned)_at_idx$'
       ORDER BY 1`;
    expect(indexes.map((i) => [i.name, i.definition.replace(/^.* USING /, "")])).toEqual([
      ["feature_expires_at_idx", "btree (expires_at) WHERE (tombstoned_at IS NULL)"],
      ["feature_tombstoned_at_idx", "btree (tombstoned_at) WHERE (tombstoned_at IS NOT NULL)"],
      ["offer_expires_at_idx", "btree (expires_at) WHERE (tombstoned_at IS NULL)"],
      ["offer_tombstoned_at_idx", "btree (tombstoned_at) WHERE (tombstoned_at IS NOT NULL)"],
    ]);
  }, 30_000);

  it("stores each value in the type it is", async () => {
    const columns = await sql<{ column: string; type: string; default: string | null }[]>`
      SELECT table_name || '.' || column_name AS column, data_type AS type,
             column_default AS default
        FROM information_schema.columns
       WHERE table_schema = 'conditions' AND (table_name, column_name) IN
         (('jma_budget', 'day'), ('segment_observation', 'confidence_score'),
          ('segment_observation', 'confidence'), ('smn_cap_message', 'retrieval'))
       ORDER BY 1`;
    expect(columns).toEqual([
      { column: "jma_budget.day", type: "date", default: null },
      { column: "segment_observation.confidence_score", type: "double precision", default: null },
      { column: "smn_cap_message.retrieval", type: "jsonb", default: null },
    ]);
  }, 30_000);
});
