import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { recomputeEvidence } from "../evidence/recompute.js";

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
  actorKeyId: string | null,
  details: Record<string, unknown> = {}
): Promise<void> {
  await sql`
    INSERT INTO conditions.report_evidence
      (observation_id, evidence_kind, actor_key_id, occurred_at, details)
    VALUES (${obsId}, ${kind}, ${actorKeyId}, ${occurredAt}, ${sql.json(details as never)})`;
}

interface DerivedRow {
  evidence_state: string | null;
  routing_eligible: boolean;
  confidence_score: number | null;
  expires_at: Date | null;
}

async function readDerived(id: string): Promise<DerivedRow> {
  const rows = await sql<DerivedRow[]>`
    SELECT evidence_state, routing_eligible, confidence_score, expires_at
    FROM conditions.observations WHERE id = ${id}`;
  return rows[0]!;
}

describe("recomputeEvidence — no-op cases", () => {
  it("returns null for a non-existent observation", async () => {
    expect(await recomputeEvidence(sql, "does-not-exist", "2026-07-11T12:00:00.000Z")).toBeNull();
  }, 30_000);

  it("returns null for an observation with zero evidence rows", async () => {
    await insertCrowdHazard("obs:no-evidence");
    expect(await recomputeEvidence(sql, "obs:no-evidence", "2026-07-11T12:00:00.000Z")).toBeNull();
    const row = await readDerived("obs:no-evidence");
    expect(row.evidence_state).toBeNull();
    expect(row.routing_eligible).toBe(false);
  }, 30_000);
});

describe("recomputeEvidence — evidence lifecycle", () => {
  it("a single crowd report → self_reported / 0.3 / not routing-eligible / +900s expiry", async () => {
    await insertCrowdHazard("obs:life");
    await addEvidence("obs:life", "report", "2026-07-11T12:00:00.000Z", "key-a");

    const result = await recomputeEvidence(sql, "obs:life", "2026-07-11T12:05:00.000Z");
    expect(result).not.toBeNull();
    expect(result!.state).toBe("self_reported");
    expect(result!.confidenceScore).toBeCloseTo(0.3, 10);
    expect(result!.routingEligible).toBe(false);
    expect(result!.expiresAt).toBe("2026-07-11T12:15:00.000Z");

    const row = await readDerived("obs:life");
    expect(row.evidence_state).toBe("self_reported");
    expect(row.routing_eligible).toBe(false);
    expect(row.confidence_score).toBeCloseTo(0.3, 10);
    expect(row.expires_at!.toISOString()).toBe("2026-07-11T12:15:00.000Z");
  }, 30_000);

  it("a distinct-key confirm → corroborated / 0.525 / still not routing-eligible / extended expiry", async () => {
    await addEvidence("obs:life", "confirm", "2026-07-11T12:10:00.000Z", "key-b");

    const result = await recomputeEvidence(sql, "obs:life", "2026-07-11T12:12:00.000Z");
    expect(result!.state).toBe("corroborated");
    // Incremental crowd confidence for a single confirmation (c=1):
    // 0.3 + (0.75 - 0.3) * (1 - 0.5^1) = 0.525, replacing the old flat 0.6.
    expect(result!.confidenceScore).toBeCloseTo(0.525, 10);
    expect(result!.routingEligible).toBe(false);
    // confirm at 12:10 + 900s crowd TTL = 12:25 (well under the 14:00 ceiling),
    // strictly later than the single-report 12:15 expiry.
    expect(result!.expiresAt).toBe("2026-07-11T12:25:00.000Z");

    const row = await readDerived("obs:life");
    expect(row.evidence_state).toBe("corroborated");
    expect(row.expires_at!.toISOString()).toBe("2026-07-11T12:25:00.000Z");
  }, 30_000);

  it("a reviewer_accept → externally_resolved / 0.9 / routing_eligible TRUE", async () => {
    await addEvidence("obs:life", "reviewer_accept", "2026-07-11T12:20:00.000Z", "reviewer-1");

    const result = await recomputeEvidence(sql, "obs:life", "2026-07-11T12:22:00.000Z");
    expect(result!.state).toBe("externally_resolved");
    expect(result!.confidenceScore).toBeCloseTo(0.9, 10);
    expect(result!.routingEligible).toBe(true);
    expect(result!.expiresAt).toBe("2026-07-11T12:35:00.000Z");

    const row = await readDerived("obs:life");
    expect(row.evidence_state).toBe("externally_resolved");
    expect(row.routing_eligible).toBe(true);
  }, 30_000);

  it("a reviewer_reject on a fresh case → negated / 0.1 / expires_at = decision time", async () => {
    await insertCrowdHazard("obs:rejected");
    await addEvidence("obs:rejected", "report", "2026-07-11T12:00:00.000Z", "key-a");
    await addEvidence("obs:rejected", "reviewer_reject", "2026-07-11T12:05:00.000Z", "reviewer-1");

    const result = await recomputeEvidence(sql, "obs:rejected", "2026-07-11T12:06:00.000Z");
    expect(result!.state).toBe("negated");
    expect(result!.confidenceScore).toBeCloseTo(0.1, 10);
    expect(result!.routingEligible).toBe(false);
    expect(result!.expiresAt).toBe("2026-07-11T12:05:00.000Z");

    const row = await readDerived("obs:rejected");
    expect(row.evidence_state).toBe("negated");
    expect(row.expires_at!.toISOString()).toBe("2026-07-11T12:05:00.000Z");
  }, 30_000);
});

describe("recomputeEvidence — concurrency (FOR UPDATE)", () => {
  it("blocks behind another transaction's row lock and then sees its committed evidence", async () => {
    await insertCrowdHazard("obs:lock");
    await addEvidence("obs:lock", "report", "2026-07-11T12:00:00.000Z", "key-a");

    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => (releaseLock = resolve));
    let signalAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => (signalAcquired = resolve));

    // tx1 takes the observation's row lock, then (while still holding it)
    // appends a reviewer_reject before committing — the exact interleaving
    // where a recompute WITHOUT the FOR UPDATE would read the pre-reject
    // ledger and commit a stale non-negated state last, masking the reject.
    const tx1 = sql.begin(async (tx) => {
      await tx`SELECT id FROM conditions.observations WHERE id = 'obs:lock' FOR UPDATE`;
      signalAcquired();
      await lockHeld;
      await tx`
        INSERT INTO conditions.report_evidence
          (observation_id, evidence_kind, actor_key_id, occurred_at, details)
        VALUES ('obs:lock', 'reviewer_reject', 'reviewer-1', '2026-07-11T12:01:00.000Z', '{}'::jsonb)`;
    });

    await lockAcquired;
    let recomputeSettled = false;
    const recompute = recomputeEvidence(sql, "obs:lock", "2026-07-11T12:02:00.000Z").then(
      (result) => {
        recomputeSettled = true;
        return result;
      }
    );

    // While tx1 holds the row lock the recompute must be blocked, not running
    // on a stale snapshot.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(recomputeSettled).toBe(false);

    releaseLock();
    await tx1;
    const result = await recompute;
    // Having waited for tx1's commit, the recompute sees the reviewer_reject.
    expect(result!.state).toBe("negated");
    expect((await readDerived("obs:lock")).evidence_state).toBe("negated");
  }, 30_000);
});

describe("recomputeEvidence — replay determinism", () => {
  it("wiping the derived columns and recomputing at the same instant yields byte-equal results", async () => {
    await insertCrowdHazard("obs:replay");
    await addEvidence("obs:replay", "report", "2026-07-11T12:00:00.000Z", "key-a");
    await addEvidence("obs:replay", "confirm", "2026-07-11T12:03:00.000Z", "key-b");
    await addEvidence("obs:replay", "reviewer_accept", "2026-07-11T12:06:00.000Z", "reviewer-1");

    const NOW = "2026-07-11T12:08:00.000Z";
    const first = await recomputeEvidence(sql, "obs:replay", NOW);
    const firstRow = await readDerived("obs:replay");

    // Wipe the materialized outputs; the raw ledger stays authoritative.
    await sql`
      UPDATE conditions.observations SET
        evidence_state = NULL, routing_eligible = false,
        confidence_score = NULL, expires_at = NULL
      WHERE id = 'obs:replay'`;

    const second = await recomputeEvidence(sql, "obs:replay", NOW);
    const secondRow = await readDerived("obs:replay");

    expect(second).toEqual(first);
    expect(secondRow.evidence_state).toBe(firstRow.evidence_state);
    expect(secondRow.routing_eligible).toBe(firstRow.routing_eligible);
    expect(secondRow.confidence_score).toBe(firstRow.confidence_score);
    expect(secondRow.expires_at!.toISOString()).toBe(firstRow.expires_at!.toISOString());
  }, 30_000);
});
