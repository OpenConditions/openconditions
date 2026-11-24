import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedFeedSituation } from "./crowd-fixtures.integration.js";

let db: TestDatabase;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 10 } });
  sql = db.sql;
});

afterAll(async () => {
  await db?.close();
}, 30_000);

async function tableColumns(table: string): Promise<Set<string>> {
  const cols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'conditions' AND table_name = ${table}`;
  return new Set(cols.map((c) => c.column_name));
}

describe("contribution tables exist", () => {
  it("creates all five contribution tables", async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'conditions'`;
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining([
        "reporter",
        "sub_claim",
        "report_evidence",
        "token_quota",
        "issuer_key",
      ]),
    );
  }, 30_000);

  it("reporter has its columns and keeps nothing it does not use", async () => {
    expect(await tableColumns("reporter")).toEqual(
      new Set([
        "key_id",
        "pub_jwk",
        "reputation_alpha",
        "reputation_beta",
        "corroborated_count",
        "trust_signal",
        "entitlement_expires_at",
        "status",
        "created_at",
        "last_active_at",
      ]),
    );
  }, 30_000);

  it("refuses a reporter without an activity or entitlement time, which retention reads", async () => {
    for (const column of ["last_active_at", "entitlement_expires_at"]) {
      const [col] = await sql<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'conditions' AND table_name = 'reporter'
          AND column_name = ${column}`;
      expect(col?.is_nullable).toBe("NO");
    }
    await expect(
      sql`INSERT INTO conditions.reporter (key_id, pub_jwk, reputation_alpha, reputation_beta,
            entitlement_expires_at, created_at, last_active_at)
          VALUES ('k-no-activity', '{}'::jsonb, 1, 1, now(), now(), NULL)`,
    ).rejects.toThrow(/last_active_at/);
  }, 30_000);

  it("token_quota and issuer_key have their columns", async () => {
    expect(await tableColumns("token_quota")).toEqual(new Set(["key_id", "epoch", "issued"]));
    expect(await tableColumns("issuer_key")).toEqual(
      new Set([
        "key_id",
        "public_key",
        "private_key_ciphertext",
        "private_key_iv",
        "private_key_tag",
        "not_before",
        "not_after",
      ]),
    );
  }, 30_000);
});

describe("crowd evidence keyed by record", () => {
  it("sub_claim names its subject by class and id", async () => {
    expect(await tableColumns("sub_claim")).toEqual(
      new Set([
        "id",
        "subject_class",
        "subject_id",
        "claim_type",
        "key_id",
        "reason",
        "geom",
        "signature",
        "created_at",
      ]),
    );
  }, 30_000);

  it("report_evidence names its record by class, id and component", async () => {
    expect(await tableColumns("report_evidence")).toEqual(
      new Set([
        "id",
        "record_class",
        "record_id",
        "component_key",
        "evidence_kind",
        "actor_key_id",
        "source_id",
        "occurred_at",
        "details",
      ]),
    );
  }, 30_000);

  it("defaults the evidence component key to the empty string, never null", async () => {
    const cols = await sql<{ is_nullable: string; column_default: string }[]>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'conditions'
        AND table_name = 'report_evidence' AND column_name = 'component_key'`;
    expect(cols).toHaveLength(1);
    expect(cols[0]!.is_nullable).toBe("NO");
    expect(cols[0]!.column_default).toContain("''");
  }, 30_000);

  it("carries the evidence summary on situation with the right nullability", async () => {
    const cols = await sql<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name = 'situation'
        AND column_name IN ('evidence_state', 'routing_eligible', 'confidence_score',
                            'corroborations', 'flagged_at')`;
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    expect(byName.get("evidence_state")?.is_nullable).toBe("YES");
    expect(byName.get("confidence_score")?.is_nullable).toBe("YES");
    expect(byName.get("flagged_at")?.is_nullable).toBe("YES");
    const routing = byName.get("routing_eligible");
    expect(routing?.is_nullable).toBe("NO");
    expect(routing?.column_default).toContain("false");
    const corroborations = byName.get("corroborations");
    expect(corroborations?.is_nullable).toBe("NO");
    expect(corroborations?.column_default).toBe("0");
  }, 30_000);

  it("creates the record-keyed indexes and drops the observation ones", async () => {
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'conditions'`;
    const names = idx.map((i) => i.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "sub_claim_subject_class_subject_id_key_id_claim_type_key",
        "idx_sub_claim_key",
        "idx_report_evidence_record",
        "idx_report_evidence_merged",
        "idx_situation_crowd_evidence",
      ]),
    );
    expect(names).not.toContain("idx_report_evidence_observation");
    expect(names).not.toContain("idx_sub_claim_subject");
    expect(names).not.toContain("uq_sub_claim_subject_key_type");
  }, 30_000);
});

describe("spent_token single-use ledger", () => {
  it("creates spent_token with its columns", async () => {
    expect(await tableColumns("spent_token")).toEqual(
      new Set(["token_hash", "purpose", "spent_at", "expires_at"]),
    );
  }, 30_000);

  it("token_hash is the primary key (a second spend violates it)", async () => {
    await sql`INSERT INTO conditions.spent_token (token_hash, purpose, spent_at, expires_at)
      VALUES ('hash-dup', 'report:-:2026-07-12', now(), now())`;
    await expect(
      sql`INSERT INTO conditions.spent_token (token_hash, purpose, spent_at, expires_at)
        VALUES ('hash-dup', 'report:-:2026-07-13', now(), now())`,
    ).rejects.toThrow(/spent_token_pkey|duplicate key/);
  }, 30_000);

  it("refuses a spent token without its expiry", async () => {
    await expect(
      sql`INSERT INTO conditions.spent_token (token_hash, purpose, spent_at)
        VALUES ('hash-no-expiry', 'report:-:2026-07-12', now())`,
    ).rejects.toThrow(/expires_at/);
  }, 30_000);

  it("indexes the expiries the retention sweep reads", async () => {
    const idx = await sql<{ tablename: string; indexname: string }[]>`
      SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'conditions'`;
    const names = idx.map((i) => `${i.tablename}.${i.indexname}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "spent_token.spent_token_expires_at_idx",
        "federation_tombstone.federation_tombstone_expires_at_idx",
        "reporter.reporter_last_active_at_idx",
      ]),
    );
    expect(names).not.toContain("spent_token.idx_spent_token_spent_at");
  }, 30_000);
});

describe("reporter erasure", () => {
  const FKS = [
    ["sub_claim", "sub_claim_key_id_fkey", "key_id", "c"],
    ["report_refusal", "report_refusal_actor_key_id_fkey", "actor_key_id", "c"],
    ["token_quota", "token_quota_key_id_fkey", "key_id", "c"],
    ["report_evidence", "report_evidence_actor_key_id_fkey", "actor_key_id", "n"],
  ] as const;

  it("references reporter from every table keyed by a reporter's key, each column indexed", async () => {
    const fks = await sql<
      { table: string; name: string; column: string; on_delete: string; target: string }[]
    >`
      SELECT c.conrelid::regclass::text AS table, c.conname AS name,
             a.attname AS column, c.confdeltype AS on_delete,
             c.confrelid::regclass::text AS target
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'conditions.reporter'::regclass
      ORDER BY c.conname`;
    expect(
      fks.map((f) => [f.table.replace(/^conditions\./, ""), f.name, f.column, f.on_delete]),
    ).toEqual([...FKS].sort((a, b) => a[1].localeCompare(b[1])));
    for (const [table, , column] of FKS) {
      const [{ indexed }] = await sql<{ indexed: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE i.indrelid = ${`conditions.${table}`}::regclass AND a.attname = ${column}
        ) AS indexed`;
      expect(indexed, `${table}.${column} leads an index`).toBe(true);
    }
  }, 30_000);

  it("deletes a reporter's votes, refusals and quotas and clears it from its evidence", async () => {
    const at = "2026-07-12T08:00:00.000Z";
    for (const key of ["k-erased", "k-kept"]) {
      await sql`INSERT INTO conditions.reporter (key_id, pub_jwk, reputation_alpha,
          reputation_beta, entitlement_expires_at, created_at, last_active_at)
        VALUES (${key}, '{}'::jsonb, 1, 1, ${at}, ${at}, ${at})`;
      await sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
        VALUES (${`sc-${key}`}, 'situation', 'subj-erasure', 'confirm', ${key}, 'sig', ${at})`;
      await sql`INSERT INTO conditions.report_refusal (actor_key_id, cell, occurred_at)
        VALUES (${key}, 'cell', ${at})`;
      await sql`INSERT INTO conditions.token_quota (key_id, epoch, issued)
        VALUES (${key}, '2026-07-12', 3)`;
      await sql`INSERT INTO conditions.report_evidence
          (record_class, record_id, evidence_kind, actor_key_id, occurred_at)
        VALUES ('situation', 'subj-erasure', 'confirm', ${key}, ${at})`;
    }

    await sql`DELETE FROM conditions.reporter WHERE key_id = 'k-erased'`;

    const count = async (table: string, column: string, key: string) => {
      const [{ n }] = await sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM conditions.${table} WHERE ${column} = $1`,
        [key],
      );
      return n;
    };
    for (const [table, , column, action] of FKS) {
      if (action !== "c") continue;
      expect(await count(table, column, "k-erased"), table).toBe(0);
      expect(await count(table, column, "k-kept"), table).toBe(1);
    }
    const evidence = await sql<{ actor_key_id: string | null }[]>`
      SELECT actor_key_id FROM conditions.report_evidence
      WHERE record_id = 'subj-erasure' ORDER BY actor_key_id NULLS FIRST`;
    expect(evidence.map((e) => e.actor_key_id)).toEqual([null, "k-kept"]);
  }, 30_000);

  it("strips a deleted reporter's key in a trigger running as the deleting role, search path pinned", async () => {
    const [trigger] = await sql<{ name: string; before_delete_row: boolean; fn: string }[]>`
      SELECT t.tgname AS name,
             (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8 AS before_delete_row,
             t.tgfoid::regprocedure::text AS fn
      FROM pg_trigger t
      WHERE t.tgrelid = 'conditions.reporter'::regclass AND NOT t.tgisinternal`;
    expect(trigger).toEqual({
      name: "reporter_strip_key",
      before_delete_row: true,
      fn: "conditions.reporter_strip_key()",
    });
    const [fn] = await sql<{ prosecdef: boolean; proconfig: string[] }[]>`
      SELECT prosecdef, proconfig FROM pg_proc
      WHERE oid = 'conditions.reporter_strip_key()'::regprocedure`;
    expect(fn).toEqual({ prosecdef: false, proconfig: ["search_path=pg_catalog, pg_temp"] });
  }, 30_000);

  it("refuses crowd rows of a key that is not an enrolled reporter", async () => {
    await expect(
      sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
        VALUES ('sc-stranger', 'situation', 'subj-1', 'confirm', 'k-stranger', 'sig', now())`,
    ).rejects.toThrow(/sub_claim_key_id_fkey/);
    await expect(
      sql`INSERT INTO conditions.report_evidence
          (record_class, record_id, evidence_kind, actor_key_id, occurred_at)
        VALUES ('situation', 'subj-1', 'confirm', 'k-stranger', now())`,
    ).rejects.toThrow(/report_evidence_actor_key_id_fkey/);
    await expect(
      sql`INSERT INTO conditions.report_evidence
          (record_class, record_id, evidence_kind, actor_key_id, occurred_at)
        VALUES ('situation', 'subj-1', 'report', NULL, now())`,
    ).resolves.toBeDefined();
  }, 30_000);
});

describe("CHECK constraints", () => {
  it("rejects a reporter with non-positive reputation_alpha", async () => {
    await expect(
      sql`INSERT INTO conditions.reporter (key_id, pub_jwk, reputation_alpha, reputation_beta,
            entitlement_expires_at, created_at, last_active_at)
          VALUES ('k-bad-a', '{}'::jsonb, 0, 1, now(), now(), now())`,
    ).rejects.toThrow(/reporter_reputation_alpha_positive/);
  }, 30_000);

  it("rejects a reporter with an unknown status", async () => {
    await expect(
      sql`INSERT INTO conditions.reporter (key_id, pub_jwk, reputation_alpha, reputation_beta,
            entitlement_expires_at, created_at, last_active_at, status)
          VALUES ('k-bad-s', '{}'::jsonb, 1, 1, now(), now(), now(), 'weird')`,
    ).rejects.toThrow(/reporter_status_enum/);
  }, 30_000);

  it("rejects a sub_claim with an unknown claim_type", async () => {
    await expect(
      sql`INSERT INTO conditions.sub_claim
            (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
          VALUES ('sc-bad', 'situation', 'subj-1', 'shout', 'k-1', 'sig', now())`,
    ).rejects.toThrow(/sub_claim_claim_type_enum/);
  }, 30_000);

  it("rejects a sub_claim whose subject is not a record class", async () => {
    await expect(
      sql`INSERT INTO conditions.sub_claim
            (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
          VALUES ('sc-bad-class', 'observations', 'subj-1', 'confirm', 'k-1', 'sig', now())`,
    ).rejects.toThrow(/sub_claim_subject_class_enum/);
  }, 30_000);

  it("rejects a report_evidence with an unknown evidence_kind", async () => {
    await expect(
      sql`INSERT INTO conditions.report_evidence
            (record_class, record_id, evidence_kind, occurred_at)
          VALUES ('situation', 'sit-1', 'telepathy', now())`,
    ).rejects.toThrow(/report_evidence_kind_enum/);
  }, 30_000);

  it("rejects a report_evidence whose record is not a record class", async () => {
    await expect(
      sql`INSERT INTO conditions.report_evidence
            (record_class, record_id, evidence_kind, occurred_at)
          VALUES ('observations', 'obs-1', 'report', now())`,
    ).rejects.toThrow(/report_evidence_record_class_enum/);
  }, 30_000);

  it("rejects a situation with an unknown evidence_state", async () => {
    const id = await seedFeedSituation(sql, "evidence-state-check");
    await expect(
      sql`UPDATE conditions.situation SET evidence_state = 'nonsense' WHERE id = ${id}`,
    ).rejects.toThrow(/situation_evidence_state_enum/);
    await expect(
      sql`UPDATE conditions.situation SET evidence_state = 'self_reported' WHERE id = ${id}`,
    ).resolves.toBeDefined();
  }, 30_000);
});

describe("unique sub_claim (subject, key, type)", () => {
  it("rejects a duplicate (subject, key, claim_type) sub-claim", async () => {
    await sql`INSERT INTO conditions.reporter (key_id, pub_jwk, reputation_alpha, reputation_beta,
        entitlement_expires_at, created_at, last_active_at)
      VALUES ('key-dup', '{}'::jsonb, 1, 1, now(), now(), now())`;
    await sql`INSERT INTO conditions.sub_claim
        (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
      VALUES ('sc-1', 'situation', 'subj-dup', 'confirm', 'key-dup', 'sig-1', now())`;
    await expect(
      sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
        VALUES ('sc-2', 'situation', 'subj-dup', 'confirm', 'key-dup', 'sig-2', now())`,
    ).rejects.toThrow(/sub_claim_subject_class_subject_id_key_id_claim_type_key/);
  }, 30_000);

  it("allows the same key a different claim_type on the same subject", async () => {
    await expect(
      sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
        VALUES ('sc-3', 'situation', 'subj-dup', 'flag', 'key-dup', 'sig-3', now())`,
    ).resolves.toBeDefined();
  }, 30_000);

  it("tells subjects apart by class", async () => {
    await expect(
      sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
        VALUES ('sc-4', 'feature', 'subj-dup', 'confirm', 'key-dup', 'sig-4', now())`,
    ).resolves.toBeDefined();
    await expect(
      sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
        VALUES ('sc-5', 'feature', 'subj-dup', 'confirm', 'key-dup', 'sig-5', now())`,
    ).rejects.toThrow(/sub_claim_subject_class_subject_id_key_id_claim_type_key/);
  }, 30_000);
});
