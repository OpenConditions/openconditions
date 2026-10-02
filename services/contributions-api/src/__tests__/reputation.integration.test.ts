import { generateReporterKey, type ReporterKey } from "@openconditions/contrib-core";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enrollReporter } from "../attester/enroll.js";
import { recomputeEvidence } from "../evidence/recompute.js";
import { applyExternalResolution } from "../reputation/resolve.js";
import {
  createTestDatabase,
  enrolledKey,
  evidenceOf,
  landAs,
  registry,
  seedFeedSituation,
  situationClaim,
} from "./crowd-fixtures.integration.js";

const T_REPORT = "2026-07-12T08:00:00.000Z";
const T_CONFIRM = "2026-07-12T08:05:00.000Z";
const T_RESOLVE = "2026-07-12T08:10:00.000Z";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 180_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.report_evidence, conditions.reporter CASCADE`;
});

async function addConfirm(id: string, key: ReporterKey, occurredAt: string): Promise<void> {
  await sql`
    INSERT INTO conditions.report_evidence
      (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
    VALUES ('situation', ${id}, 'confirm', ${key.keyId}, ${occurredAt}, '{}'::jsonb)`;
}

interface ReporterRow {
  reputation_alpha: number;
  reputation_beta: number;
  corroborated_count: number;
}

async function readReporter(key: ReporterKey | string): Promise<ReporterRow> {
  const keyId = typeof key === "string" ? key : key.keyId;
  const rows = await sql<ReporterRow[]>`
    SELECT reputation_alpha, reputation_beta, corroborated_count
    FROM conditions.reporter WHERE key_id = ${keyId}`;
  expect(rows[0]).toBeDefined();
  return rows[0]!;
}

interface ExternalEvidenceRow {
  evidence_kind: string;
  source_id: string | null;
  details: Record<string, unknown>;
}

async function readExternalEvidence(id: string): Promise<ExternalEvidenceRow[]> {
  return sql<ExternalEvidenceRow[]>`
    SELECT evidence_kind, source_id, details FROM conditions.report_evidence
    WHERE record_class = 'situation' AND record_id = ${id}
      AND evidence_kind IN ('official_match', 'reviewer_accept', 'reviewer_reject')
    ORDER BY id`;
}

/** A crowd report landed by a freshly enrolled reporter at the cohort prior. */
async function seedReport(): Promise<{ id: string; reporter: ReporterKey }> {
  const reporter = await enrolledKey(sql, T_REPORT);
  const landed = await landAs(sql, reporter, situationClaim({ reportedAt: T_REPORT }), T_REPORT);
  return { id: landed.record.id, reporter };
}

describe("applyExternalResolution — confirmed outcomes", () => {
  it("official confirmation trains the originating reporter's α and routes the report", async () => {
    const { id, reporter } = await seedReport();

    const result = await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "official", outcome: "confirmed" },
      T_RESOLVE,
    );
    expect(result).toEqual({ evidenceState: "externally_resolved", routingEligible: true });

    expect(await readReporter(reporter)).toMatchObject({ reputation_alpha: 3, reputation_beta: 2 });

    const evidence = await readExternalEvidence(id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence_kind).toBe("official_match");
    expect(evidence[0]!.details).toEqual({ source: "official", outcome: "confirmed" });

    expect(await evidenceOf(sql, id)).toMatchObject({
      evidence_state: "externally_resolved",
      routing_eligible: true,
    });
  }, 30_000);

  it("records the matched feed record and its source on an official confirmation", async () => {
    const { id } = await seedReport();
    const feed = await seedFeedSituation(sql, "rep-matched");

    await applyExternalResolution(
      sql,
      registry,
      id,
      {
        source: "official",
        outcome: "confirmed",
        matchedRecord: { class: "situation", id: feed, sourceId: "de-autobahn" },
      },
      T_RESOLVE,
    );

    const evidence = await readExternalEvidence(id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.source_id).toBe("de-autobahn");
    expect(evidence[0]!.details).toEqual({
      source: "official",
      outcome: "confirmed",
      matchedRecord: { class: "situation", id: feed },
    });
  }, 30_000);

  it("reviewer confirmation appends reviewer_accept", async () => {
    const { id } = await seedReport();

    const result = await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "reviewer", outcome: "confirmed" },
      T_RESOLVE,
    );
    expect(result).toEqual({ evidenceState: "externally_resolved", routingEligible: true });

    const evidence = await readExternalEvidence(id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence_kind).toBe("reviewer_accept");
    expect(evidence[0]!.details).toEqual({ source: "reviewer", outcome: "confirmed" });
  }, 30_000);

  it("objective confirmation maps to official_match with details.source = objective", async () => {
    const { id } = await seedReport();

    const result = await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "objective", outcome: "confirmed" },
      T_RESOLVE,
    );
    expect(result).toEqual({ evidenceState: "externally_resolved", routingEligible: true });

    const evidence = await readExternalEvidence(id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence_kind).toBe("official_match");
    expect(evidence[0]!.details).toEqual({ source: "objective", outcome: "confirmed" });
  }, 30_000);
});

describe("applyExternalResolution — rejected outcomes", () => {
  it("reviewer rejection trains β and negates the report", async () => {
    const { id, reporter } = await seedReport();

    const result = await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "reviewer", outcome: "rejected" },
      T_RESOLVE,
    );
    expect(result).toEqual({ evidenceState: "negated", routingEligible: false });

    expect(await readReporter(reporter)).toMatchObject({ reputation_alpha: 2, reputation_beta: 3 });

    const evidence = await readExternalEvidence(id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence_kind).toBe("reviewer_reject");
    expect(evidence[0]!.details).toEqual({ source: "reviewer", outcome: "rejected" });
  }, 30_000);

  it("official and objective rejections map to reviewer_reject with the true source recorded", async () => {
    const official = await seedReport();
    const objective = await seedReport();

    await applyExternalResolution(
      sql,
      registry,
      official.id,
      { source: "official", outcome: "rejected" },
      T_RESOLVE,
    );
    await applyExternalResolution(
      sql,
      registry,
      objective.id,
      { source: "objective", outcome: "rejected" },
      T_RESOLVE,
    );

    const officialRows = await readExternalEvidence(official.id);
    expect(officialRows[0]!.evidence_kind).toBe("reviewer_reject");
    expect(officialRows[0]!.details).toEqual({ source: "official", outcome: "rejected" });
    const objectiveRows = await readExternalEvidence(objective.id);
    expect(objectiveRows[0]!.evidence_kind).toBe("reviewer_reject");
    expect(objectiveRows[0]!.details).toEqual({ source: "objective", outcome: "rejected" });
  }, 30_000);

  it("a rejection also trains a confirming key's β (their corroboration was wrong)", async () => {
    const { id, reporter } = await seedReport();
    const confirmer = await enrolledKey(sql, T_REPORT);
    await addConfirm(id, confirmer, T_CONFIRM);

    await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "reviewer", outcome: "rejected" },
      T_RESOLVE,
    );

    expect((await readReporter(reporter)).reputation_beta).toBe(3);
    expect(await readReporter(confirmer)).toEqual({
      reputation_alpha: 2,
      reputation_beta: 3,
      corroborated_count: 0,
    });
  }, 30_000);
});

describe("reputation trains ONLY on external resolution", () => {
  it("a corroboration that is never externally resolved leaves ALL posteriors untouched", async () => {
    const { id, reporter } = await seedReport();
    const confirmer = await enrolledKey(sql, T_REPORT);
    await addConfirm(id, confirmer, T_CONFIRM);
    const result = await recomputeEvidence(sql, registry, id, T_CONFIRM);

    // The crowd agreement DID change the evidence state …
    expect(result).toMatchObject({ state: "corroborated", routingEligible: false });

    // … but no posterior moved: crowd agreement never trains reputation.
    const prior = { reputation_alpha: 2, reputation_beta: 2, corroborated_count: 0 };
    expect(await readReporter(reporter)).toEqual(prior);
    expect(await readReporter(confirmer)).toEqual(prior);
  }, 30_000);

  it("on a confirmed resolution the confirming key is trained, an unrelated key is not", async () => {
    const { id, reporter } = await seedReport();
    const confirmer = await enrolledKey(sql, T_REPORT);
    const unrelated = await enrolledKey(sql, T_REPORT);
    await addConfirm(id, confirmer, T_CONFIRM);

    await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "official", outcome: "confirmed" },
      T_RESOLVE,
    );

    expect(await readReporter(reporter)).toMatchObject({
      reputation_alpha: 3,
      corroborated_count: 0,
    });
    expect(await readReporter(confirmer)).toEqual({
      reputation_alpha: 3,
      reputation_beta: 2,
      corroborated_count: 1,
    });
    expect(await readReporter(unrelated)).toEqual({
      reputation_alpha: 2,
      reputation_beta: 2,
      corroborated_count: 0,
    });
  }, 30_000);
});

describe("applyExternalResolution — late-confirm reputation free-ride is blocked", () => {
  it("trains only confirms strictly before the FIRST resolution, even across a second distinct-source resolution", async () => {
    const { id, reporter } = await seedReport();
    const early = await enrolledKey(sql, T_REPORT);
    const late = await enrolledKey(sql, T_REPORT);

    // An early confirm PRECEDES the first resolution; a late confirm POSTDATES it.
    await addConfirm(id, early, T_CONFIRM);
    await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "official", outcome: "confirmed" },
      T_RESOLVE,
    );

    // This confirm lands AFTER the report was already settled (the vote route
    // refuses it; the reputation math must independently refuse to train it).
    await addConfirm(id, late, "2026-07-12T08:15:00.000Z");

    // A second, independent-source validation. The pre-first-resolution
    // confirmer carries signal for it too; the late confirmer stays untrained.
    await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "reviewer", outcome: "confirmed" },
      "2026-07-12T08:20:00.000Z",
    );

    expect((await readReporter(reporter)).reputation_alpha).toBe(4);
    expect(await readReporter(early)).toMatchObject({
      reputation_alpha: 4,
      corroborated_count: 2,
    });
    expect(await readReporter(late)).toEqual({
      reputation_alpha: 2,
      reputation_beta: 2,
      corroborated_count: 0,
    });
  }, 30_000);
});

describe("applyExternalResolution — idempotence under double resolution", () => {
  it("a second identical resolution updates the posterior exactly once", async () => {
    const { id, reporter } = await seedReport();

    const first = await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "official", outcome: "confirmed" },
      T_RESOLVE,
    );
    const second = await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "official", outcome: "confirmed" },
      "2026-07-12T08:20:00.000Z",
    );
    expect(first).toEqual({ evidenceState: "externally_resolved", routingEligible: true });
    expect(second).toEqual({ evidenceState: "externally_resolved", routingEligible: true });

    expect(await readReporter(reporter)).toMatchObject({ reputation_alpha: 3, reputation_beta: 2 });
    expect(await readExternalEvidence(id)).toHaveLength(1);
  }, 30_000);

  it("a confirmer's corroborated_count also bumps exactly once", async () => {
    const { id } = await seedReport();
    const confirmer = await enrolledKey(sql, T_REPORT);
    await addConfirm(id, confirmer, T_CONFIRM);

    for (const now of [T_RESOLVE, "2026-07-12T08:30:00.000Z"]) {
      await applyExternalResolution(
        sql,
        registry,
        id,
        { source: "reviewer", outcome: "confirmed" },
        now,
      );
    }

    expect(await readReporter(confirmer)).toMatchObject({
      reputation_alpha: 3,
      corroborated_count: 1,
    });
  }, 30_000);
});

describe("applyExternalResolution — edges", () => {
  it("returns null for an unknown situation", async () => {
    const result = await applyExternalResolution(
      sql,
      registry,
      "oc:situation:does-not-exist",
      { source: "official", outcome: "confirmed" },
      T_RESOLVE,
    );
    expect(result).toBeNull();
  }, 30_000);

  it("a freshly enrolled key starts at the cohort prior Beta(2, 2)", async () => {
    const key = await generateReporterKey();
    await enrollReporter(sql, key.publicJwk, { keyId: key.keyId }, T_REPORT, {
      grantSecret: new TextEncoder().encode("reputation-test-secret"),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(await readReporter(key)).toMatchObject({ reputation_alpha: 2, reputation_beta: 2 });
  }, 30_000);
});
