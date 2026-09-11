import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { generateReporterKey } from "@openconditions/contrib-core";
import { runMigrations } from "@openconditions/core/server";
import { enrollReporter } from "../attester/enroll.js";
import { recomputeEvidence } from "../evidence/recompute.js";
import { applyExternalResolution } from "../reputation/resolve.js";

const T_REPORT = "2026-07-12T08:00:00.000Z";
const T_CONFIRM = "2026-07-12T08:05:00.000Z";
const T_RESOLVE = "2026-07-12T08:10:00.000Z";

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

async function insertCrowdHazard(id: string): Promise<void> {
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, status, geom, origin,
       data_updated_at, fetched_at, is_stale)
    VALUES
      (${id}, 'crowd', 'native', 'roads', 'event', 'hazard', 'active',
       ST_SetSRID(ST_MakePoint(4, 52), 4326), '{"kind":"crowd"}'::jsonb,
       now(), now(), false)`;
}

async function addEvidence(
  obsId: string,
  kind: string,
  occurredAt: string,
  actorKeyId: string | null
): Promise<void> {
  await sql`
    INSERT INTO conditions.report_evidence
      (observation_id, evidence_kind, actor_key_id, occurred_at, details)
    VALUES (${obsId}, ${kind}, ${actorKeyId}, ${occurredAt}, '{}'::jsonb)`;
}

async function insertReporter(keyId: string, alpha = 2, beta = 2): Promise<void> {
  await sql`
    INSERT INTO conditions.reporter
      (key_id, pub_jwk, reputation_alpha, reputation_beta,
       entitlement_expires_at, status, created_at, last_active_at)
    VALUES
      (${keyId}, '{}'::jsonb, ${alpha}, ${beta},
       '2027-01-01T00:00:00Z', 'active', ${T_REPORT}, ${T_REPORT})`;
}

interface ReporterRow {
  reputation_alpha: number;
  reputation_beta: number;
  corroborated_count: number;
}

async function readReporter(keyId: string): Promise<ReporterRow> {
  const rows = await sql<ReporterRow[]>`
    SELECT reputation_alpha, reputation_beta, corroborated_count
    FROM conditions.reporter WHERE key_id = ${keyId}`;
  expect(rows[0]).toBeDefined();
  return rows[0]!;
}

interface ExternalEvidenceRow {
  evidence_kind: string;
  details: { source?: string; outcome?: string };
}

async function readExternalEvidence(obsId: string): Promise<ExternalEvidenceRow[]> {
  return sql<ExternalEvidenceRow[]>`
    SELECT evidence_kind, details FROM conditions.report_evidence
    WHERE observation_id = ${obsId}
      AND evidence_kind IN ('official_match', 'reviewer_accept', 'reviewer_reject')
    ORDER BY id`;
}

/** A reported observation with an enrolled-equivalent reporter row at the cohort prior. */
async function seedReportedObservation(obsId: string, reporterKey: string): Promise<void> {
  await insertCrowdHazard(obsId);
  await insertReporter(reporterKey);
  await addEvidence(obsId, "report", T_REPORT, reporterKey);
  await recomputeEvidence(sql, obsId, T_REPORT);
}

describe("applyExternalResolution — confirmed outcomes", () => {
  it("official confirmation trains the originating reporter's α and flips state to externally_resolved", async () => {
    await seedReportedObservation("obs:conf-official", "rep-conf-official");

    const result = await applyExternalResolution(
      sql,
      "obs:conf-official",
      { source: "official", outcome: "confirmed" },
      T_RESOLVE
    );
    expect(result).toEqual({ evidenceState: "externally_resolved", routingEligible: true });

    const reporter = await readReporter("rep-conf-official");
    expect(reporter.reputation_alpha).toBe(3);
    expect(reporter.reputation_beta).toBe(2);

    const evidence = await readExternalEvidence("obs:conf-official");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence_kind).toBe("official_match");
    expect(evidence[0]!.details).toEqual({ source: "official", outcome: "confirmed" });

    const obs = await sql<{ evidence_state: string; routing_eligible: boolean }[]>`
      SELECT evidence_state, routing_eligible FROM conditions.observations
      WHERE id = 'obs:conf-official'`;
    expect(obs[0]!.evidence_state).toBe("externally_resolved");
    expect(obs[0]!.routing_eligible).toBe(true);
  }, 30_000);

  it("reviewer confirmation appends reviewer_accept", async () => {
    await seedReportedObservation("obs:conf-reviewer", "rep-conf-reviewer");

    const result = await applyExternalResolution(
      sql,
      "obs:conf-reviewer",
      { source: "reviewer", outcome: "confirmed" },
      T_RESOLVE
    );
    expect(result).toEqual({ evidenceState: "externally_resolved", routingEligible: true });

    const evidence = await readExternalEvidence("obs:conf-reviewer");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence_kind).toBe("reviewer_accept");
    expect(evidence[0]!.details).toEqual({ source: "reviewer", outcome: "confirmed" });
  }, 30_000);

  it("objective confirmation maps to official_match with details.source = objective", async () => {
    await seedReportedObservation("obs:conf-objective", "rep-conf-objective");

    const result = await applyExternalResolution(
      sql,
      "obs:conf-objective",
      { source: "objective", outcome: "confirmed" },
      T_RESOLVE
    );
    expect(result).toEqual({ evidenceState: "externally_resolved", routingEligible: true });

    const evidence = await readExternalEvidence("obs:conf-objective");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence_kind).toBe("official_match");
    expect(evidence[0]!.details).toEqual({ source: "objective", outcome: "confirmed" });
  }, 30_000);
});

describe("applyExternalResolution — rejected outcomes", () => {
  it("reviewer rejection trains β and negates the observation", async () => {
    await seedReportedObservation("obs:rej-reviewer", "rep-rej-reviewer");

    const result = await applyExternalResolution(
      sql,
      "obs:rej-reviewer",
      { source: "reviewer", outcome: "rejected" },
      T_RESOLVE
    );
    expect(result).toEqual({ evidenceState: "negated", routingEligible: false });

    const reporter = await readReporter("rep-rej-reviewer");
    expect(reporter.reputation_alpha).toBe(2);
    expect(reporter.reputation_beta).toBe(3);

    const evidence = await readExternalEvidence("obs:rej-reviewer");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence_kind).toBe("reviewer_reject");
    expect(evidence[0]!.details).toEqual({ source: "reviewer", outcome: "rejected" });
  }, 30_000);

  it("official and objective rejections map to reviewer_reject with the true source recorded", async () => {
    await seedReportedObservation("obs:rej-official", "rep-rej-official");
    await seedReportedObservation("obs:rej-objective", "rep-rej-objective");

    await applyExternalResolution(
      sql,
      "obs:rej-official",
      { source: "official", outcome: "rejected" },
      T_RESOLVE
    );
    await applyExternalResolution(
      sql,
      "obs:rej-objective",
      { source: "objective", outcome: "rejected" },
      T_RESOLVE
    );

    const official = await readExternalEvidence("obs:rej-official");
    expect(official[0]!.evidence_kind).toBe("reviewer_reject");
    expect(official[0]!.details).toEqual({ source: "official", outcome: "rejected" });
    const objective = await readExternalEvidence("obs:rej-objective");
    expect(objective[0]!.evidence_kind).toBe("reviewer_reject");
    expect(objective[0]!.details).toEqual({ source: "objective", outcome: "rejected" });
  }, 30_000);

  it("a rejection also trains a confirming key's β (their corroboration was wrong)", async () => {
    await seedReportedObservation("obs:rej-confirmer", "rep-rej-orig");
    await insertReporter("rep-rej-confirmer");
    await addEvidence("obs:rej-confirmer", "confirm", T_CONFIRM, "rep-rej-confirmer");

    await applyExternalResolution(
      sql,
      "obs:rej-confirmer",
      { source: "reviewer", outcome: "rejected" },
      T_RESOLVE
    );

    const originator = await readReporter("rep-rej-orig");
    expect(originator.reputation_beta).toBe(3);
    const confirmer = await readReporter("rep-rej-confirmer");
    expect(confirmer.reputation_alpha).toBe(2);
    expect(confirmer.reputation_beta).toBe(3);
    expect(confirmer.corroborated_count).toBe(0);
  }, 30_000);
});

describe("reputation trains ONLY on external resolution", () => {
  it("a corroboration that is never externally resolved leaves ALL posteriors untouched", async () => {
    await seedReportedObservation("obs:crowd-only", "rep-crowd-orig");
    await insertReporter("rep-crowd-confirmer");
    await addEvidence("obs:crowd-only", "confirm", T_CONFIRM, "rep-crowd-confirmer");
    const result = await recomputeEvidence(sql, "obs:crowd-only", T_CONFIRM);

    // The crowd agreement DID change the evidence state …
    expect(result!.state).toBe("corroborated");
    expect(result!.routingEligible).toBe(false);

    // … but no posterior moved: crowd agreement never trains reputation.
    const originator = await readReporter("rep-crowd-orig");
    expect(originator.reputation_alpha).toBe(2);
    expect(originator.reputation_beta).toBe(2);
    const confirmer = await readReporter("rep-crowd-confirmer");
    expect(confirmer.reputation_alpha).toBe(2);
    expect(confirmer.reputation_beta).toBe(2);
    expect(confirmer.corroborated_count).toBe(0);
  }, 30_000);

  it("on a confirmed resolution the confirming key is trained, an unrelated key is not", async () => {
    await seedReportedObservation("obs:with-confirmer", "rep-orig");
    await insertReporter("rep-confirmer");
    await insertReporter("rep-unrelated");
    await addEvidence("obs:with-confirmer", "confirm", T_CONFIRM, "rep-confirmer");

    await applyExternalResolution(
      sql,
      "obs:with-confirmer",
      { source: "official", outcome: "confirmed" },
      T_RESOLVE
    );

    const originator = await readReporter("rep-orig");
    expect(originator.reputation_alpha).toBe(3);
    expect(originator.corroborated_count).toBe(0);

    const confirmer = await readReporter("rep-confirmer");
    expect(confirmer.reputation_alpha).toBe(3);
    expect(confirmer.reputation_beta).toBe(2);
    expect(confirmer.corroborated_count).toBe(1);

    const unrelated = await readReporter("rep-unrelated");
    expect(unrelated.reputation_alpha).toBe(2);
    expect(unrelated.reputation_beta).toBe(2);
    expect(unrelated.corroborated_count).toBe(0);
  }, 30_000);
});

describe("applyExternalResolution — late-confirm reputation free-ride is blocked", () => {
  it("trains only confirms strictly before the FIRST resolution, even across a second distinct-source resolution", async () => {
    await seedReportedObservation("obs:late-confirm", "rep-lc-orig");
    await insertReporter("rep-lc-early");
    await insertReporter("rep-lc-late");

    // An early confirm PRECEDES the first resolution; a late confirm POSTDATES it.
    await addEvidence("obs:late-confirm", "confirm", T_CONFIRM, "rep-lc-early");
    const firstResolveAt = T_RESOLVE;
    const lateConfirmAt = "2026-07-12T08:15:00.000Z";
    const secondResolveAt = "2026-07-12T08:20:00.000Z";

    await applyExternalResolution(
      sql,
      "obs:late-confirm",
      { source: "official", outcome: "confirmed" },
      firstResolveAt
    );

    // This confirm lands AFTER the observation was already settled (in the live
    // system the vote route 409s it; the reputation math must independently
    // refuse to train it).
    await addEvidence("obs:late-confirm", "confirm", lateConfirmAt, "rep-lc-late");

    // A second, independent-source validation. The pre-first-resolution confirmer
    // carries signal for it too (different-source-trains-again is intended); the
    // late confirmer must remain untrained.
    await applyExternalResolution(
      sql,
      "obs:late-confirm",
      { source: "reviewer", outcome: "confirmed" },
      secondResolveAt
    );

    const originator = await readReporter("rep-lc-orig");
    expect(originator.reputation_alpha).toBe(4); // trained by both resolutions

    const early = await readReporter("rep-lc-early");
    expect(early.reputation_alpha).toBe(4); // pre-cutoff → trained by both
    expect(early.corroborated_count).toBe(2);

    const late = await readReporter("rep-lc-late");
    expect(late.reputation_alpha).toBe(2); // postdates first resolution → never trained
    expect(late.reputation_beta).toBe(2);
    expect(late.corroborated_count).toBe(0);
  }, 30_000);
});

describe("applyExternalResolution — idempotence under double resolution", () => {
  it("a second identical resolution updates the posterior exactly once", async () => {
    await seedReportedObservation("obs:double", "rep-double");

    const first = await applyExternalResolution(
      sql,
      "obs:double",
      { source: "official", outcome: "confirmed" },
      T_RESOLVE
    );
    const second = await applyExternalResolution(
      sql,
      "obs:double",
      { source: "official", outcome: "confirmed" },
      "2026-07-12T08:20:00.000Z"
    );
    expect(first).toEqual({ evidenceState: "externally_resolved", routingEligible: true });
    expect(second).toEqual({ evidenceState: "externally_resolved", routingEligible: true });

    const reporter = await readReporter("rep-double");
    expect(reporter.reputation_alpha).toBe(3);
    expect(reporter.reputation_beta).toBe(2);

    const evidence = await readExternalEvidence("obs:double");
    expect(evidence).toHaveLength(1);
  }, 30_000);

  it("a confirmer's corroborated_count also bumps exactly once", async () => {
    await seedReportedObservation("obs:double-confirmer", "rep-double-orig");
    await insertReporter("rep-double-confirmer");
    await addEvidence("obs:double-confirmer", "confirm", T_CONFIRM, "rep-double-confirmer");

    for (const now of [T_RESOLVE, "2026-07-12T08:30:00.000Z"]) {
      await applyExternalResolution(
        sql,
        "obs:double-confirmer",
        { source: "reviewer", outcome: "confirmed" },
        now
      );
    }

    const confirmer = await readReporter("rep-double-confirmer");
    expect(confirmer.reputation_alpha).toBe(3);
    expect(confirmer.corroborated_count).toBe(1);
  }, 30_000);
});

describe("applyExternalResolution — edges", () => {
  it("returns null for an unknown observation", async () => {
    const result = await applyExternalResolution(
      sql,
      "obs:does-not-exist",
      { source: "official", outcome: "confirmed" },
      T_RESOLVE
    );
    expect(result).toBeNull();
  }, 30_000);

  it("a freshly enrolled key starts at the cohort prior Beta(2, 2)", async () => {
    const key = await generateReporterKey();
    await enrollReporter(sql, key.publicJwk, { keyId: key.keyId }, T_REPORT, {
      grantSecret: new TextEncoder().encode("reputation-test-secret"),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const reporter = await readReporter(key.keyId);
    expect(reporter.reputation_alpha).toBe(2);
    expect(reporter.reputation_beta).toBe(2);
  }, 30_000);
});
