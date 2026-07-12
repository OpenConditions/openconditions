import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

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
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

async function tableColumns(table: string): Promise<Set<string>> {
  const cols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'conditions' AND table_name = ${table}`;
  return new Set(cols.map((c) => c.column_name));
}

describe("migration 0008 — contribution tables exist", () => {
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
      ])
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

  it("sub_claim, report_evidence, token_quota, issuer_key have their columns", async () => {
    expect(await tableColumns("sub_claim")).toEqual(
      new Set([
        "id",
        "subject_id",
        "claim_type",
        "key_id",
        "reason",
        "geom",
        "signature",
        "created_at",
      ])
    );
    expect(await tableColumns("report_evidence")).toEqual(
      new Set([
        "id",
        "observation_id",
        "evidence_kind",
        "actor_key_id",
        "source_id",
        "occurred_at",
        "details",
      ])
    );
    expect(await tableColumns("token_quota")).toEqual(new Set(["key_id", "epoch", "issued"]));
    expect(await tableColumns("issuer_key")).toEqual(
      new Set(["key_id", "public_key", "private_key", "not_before", "not_after"])
    );
  }, 30_000);

  it("adds evidence_state + routing_eligible to observations with the right nullability", async () => {
    const cols = await sql<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name = 'observations'
        AND column_name IN ('evidence_state', 'routing_eligible')`;
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    expect(byName.get("evidence_state")?.is_nullable).toBe("YES");
    const routing = byName.get("routing_eligible");
    expect(routing?.is_nullable).toBe("NO");
    expect(routing?.column_default).toContain("false");
  }, 30_000);
});

describe("migration 0008 — indexes", () => {
  it("creates the contribution indexes", async () => {
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'conditions'`;
    const names = idx.map((i) => i.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "uq_sub_claim_subject_key_type",
        "idx_sub_claim_subject",
        "idx_sub_claim_key",
        "idx_report_evidence_observation",
        "idx_conditions_obs_evidence_state",
      ])
    );
  }, 30_000);
});

describe("migration 0008 — CHECK constraints", () => {
  it("rejects a reporter with non-positive reputation_alpha", async () => {
    await expect(
      sql`INSERT INTO conditions.reporter (key_id, pub_jwk, reputation_alpha, reputation_beta,
            entitlement_expires_at, created_at, last_active_at)
          VALUES ('k-bad-a', '{}'::jsonb, 0, 1, now(), now(), now())`
    ).rejects.toThrow(/reporter_reputation_alpha_positive/);
  }, 30_000);

  it("rejects a reporter with an unknown status", async () => {
    await expect(
      sql`INSERT INTO conditions.reporter (key_id, pub_jwk, reputation_alpha, reputation_beta,
            entitlement_expires_at, created_at, last_active_at, status)
          VALUES ('k-bad-s', '{}'::jsonb, 1, 1, now(), now(), now(), 'weird')`
    ).rejects.toThrow(/reporter_status_enum/);
  }, 30_000);

  it("rejects a sub_claim with an unknown claim_type", async () => {
    await expect(
      sql`INSERT INTO conditions.sub_claim (id, subject_id, claim_type, key_id, signature, created_at)
          VALUES ('sc-bad', 'subj-1', 'shout', 'k-1', 'sig', now())`
    ).rejects.toThrow(/sub_claim_claim_type_enum/);
  }, 30_000);

  it("rejects a report_evidence with an unknown evidence_kind", async () => {
    await expect(
      sql`INSERT INTO conditions.report_evidence (observation_id, evidence_kind, occurred_at)
          VALUES ('obs-1', 'telepathy', now())`
    ).rejects.toThrow(/report_evidence_kind_enum/);
  }, 30_000);

  it("rejects an observation with an unknown evidence_state", async () => {
    await expect(
      sql`INSERT INTO conditions.observations
            (id, source, source_format, domain, kind, status, geom, origin,
             data_updated_at, fetched_at, is_stale, evidence_state)
          VALUES ('obs-es-bad', 'chk', 'native', 'roads', 'event', 'active',
             ST_SetSRID(ST_MakePoint(0,0), 4326), '{}'::jsonb, now(), now(), false, 'nonsense')`
    ).rejects.toThrow(/obs_evidence_state_enum/);
  }, 30_000);
});

describe("migration 0008 — unique sub_claim (subject, key, type)", () => {
  it("rejects a duplicate (subject_id, key_id, claim_type) sub-claim", async () => {
    await sql`INSERT INTO conditions.sub_claim (id, subject_id, claim_type, key_id, signature, created_at)
      VALUES ('sc-1', 'subj-dup', 'confirm', 'key-dup', 'sig-1', now())`;
    await expect(
      sql`INSERT INTO conditions.sub_claim (id, subject_id, claim_type, key_id, signature, created_at)
        VALUES ('sc-2', 'subj-dup', 'confirm', 'key-dup', 'sig-2', now())`
    ).rejects.toThrow(/uq_sub_claim_subject_key_type/);
  }, 30_000);

  it("allows the same key a different claim_type on the same subject", async () => {
    await expect(
      sql`INSERT INTO conditions.sub_claim (id, subject_id, claim_type, key_id, signature, created_at)
        VALUES ('sc-3', 'subj-dup', 'flag', 'key-dup', 'sig-3', now())`
    ).resolves.toBeDefined();
  }, 30_000);
});
