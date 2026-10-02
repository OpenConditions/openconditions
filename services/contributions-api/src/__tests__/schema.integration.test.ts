import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seedFeedSituation } from "./crowd-fixtures.integration.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120_000);

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

  it("reporter has its columns", async () => {
    const cols = await tableColumns("reporter");
    for (const c of [
      "key_id",
      "pub_jwk",
      "osm_uid",
      "email_lookup_hmac",
      "reputation_alpha",
      "reputation_beta",
      "corroborated_count",
      "flagged_count",
      "trust_signal",
      "entitlement_expires_at",
      "status",
      "created_at",
      "last_active_at",
    ]) {
      expect(cols.has(c)).toBe(true);
    }
  }, 30_000);

  it("token_quota and issuer_key have their columns", async () => {
    expect(await tableColumns("token_quota")).toEqual(new Set(["key_id", "epoch", "issued"]));
    expect(await tableColumns("issuer_key")).toEqual(
      new Set(["key_id", "public_key", "private_key", "not_before", "not_after"]),
    );
  }, 30_000);
});

describe("migration 0045 — crowd evidence keyed by record", () => {
  it("sub_claim names its subject by class, id and component", async () => {
    expect(await tableColumns("sub_claim")).toEqual(
      new Set([
        "id",
        "subject_class",
        "subject_id",
        "subject_component_key",
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

  it("defaults the component keys to the empty string, never null", async () => {
    const cols = await sql<
      { table_name: string; column_name: string; is_nullable: string; column_default: string }[]
    >`
      SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'conditions'
        AND ((table_name = 'report_evidence' AND column_name = 'component_key')
          OR (table_name = 'sub_claim' AND column_name = 'subject_component_key'))`;
    expect(cols).toHaveLength(2);
    for (const col of cols) {
      expect(col.is_nullable).toBe("NO");
      expect(col.column_default).toContain("''");
    }
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
        "uq_sub_claim_subject_key_type",
        "idx_sub_claim_key",
        "idx_report_evidence_record",
        "idx_report_evidence_merged",
        "idx_situation_crowd_evidence",
      ]),
    );
    expect(names).not.toContain("idx_report_evidence_observation");
    expect(names).not.toContain("idx_sub_claim_subject");
  }, 30_000);
});

describe("migration 0009 — spent_token single-use ledger", () => {
  it("creates spent_token with its columns", async () => {
    expect(await tableColumns("spent_token")).toEqual(
      new Set(["token_hash", "purpose", "spent_at"]),
    );
  }, 30_000);

  it("token_hash is the primary key (a second spend violates it)", async () => {
    await sql`INSERT INTO conditions.spent_token (token_hash, purpose, spent_at)
      VALUES ('hash-dup', 'report:-:2026-07-12', now())`;
    await expect(
      sql`INSERT INTO conditions.spent_token (token_hash, purpose, spent_at)
        VALUES ('hash-dup', 'report:-:2026-07-13', now())`,
    ).rejects.toThrow(/spent_token_pkey|duplicate key/);
  }, 30_000);

  it("indexes spent_at for the retention sweep", async () => {
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'conditions' AND tablename = 'spent_token'`;
    expect(idx.map((i) => i.indexname)).toContain("idx_spent_token_spent_at");
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
    await sql`INSERT INTO conditions.sub_claim
        (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
      VALUES ('sc-1', 'situation', 'subj-dup', 'confirm', 'key-dup', 'sig-1', now())`;
    await expect(
      sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
        VALUES ('sc-2', 'situation', 'subj-dup', 'confirm', 'key-dup', 'sig-2', now())`,
    ).rejects.toThrow(/uq_sub_claim_subject_key_type/);
  }, 30_000);

  it("allows the same key a different claim_type on the same subject", async () => {
    await expect(
      sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
        VALUES ('sc-3', 'situation', 'subj-dup', 'flag', 'key-dup', 'sig-3', now())`,
    ).resolves.toBeDefined();
  }, 30_000);

  it("tells subjects apart by class and component", async () => {
    await expect(
      sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, signature, created_at)
        VALUES ('sc-4', 'feature', 'subj-dup', 'confirm', 'key-dup', 'sig-4', now())`,
    ).resolves.toBeDefined();
    await expect(
      sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, subject_component_key, claim_type, key_id, signature,
           created_at)
        VALUES ('sc-5', 'feature', 'subj-dup', 'evse-1', 'confirm', 'key-dup', 'sig-5', now())`,
    ).resolves.toBeDefined();
    await expect(
      sql`INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, subject_component_key, claim_type, key_id, signature,
           created_at)
        VALUES ('sc-6', 'feature', 'subj-dup', 'evse-1', 'confirm', 'key-dup', 'sig-6', now())`,
    ).rejects.toThrow(/uq_sub_claim_subject_key_type/);
  }, 30_000);
});
