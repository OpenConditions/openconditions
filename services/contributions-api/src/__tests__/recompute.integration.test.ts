import type { ReporterKey } from "@openconditions/contrib-core";
import { crowdRulesFor } from "@openconditions/model";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recomputeEvidence } from "../evidence/recompute.js";
import {
  createTestDatabase,
  enrolledKey,
  landAs,
  registry,
  seedFeedSituation,
  situationClaim,
} from "./crowd-fixtures.integration.js";

const T0 = "2026-07-12T08:00:00.000Z";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let alice: ReporterKey;
let bob: ReporterKey;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 180_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.report_evidence, conditions.reporter CASCADE`;
  [alice, bob] = await Promise.all([enrolledKey(sql, T0), enrolledKey(sql, T0)]);
});

/** Lands alice's obstruction report, made and received at `T0` unless told otherwise. */
async function landReport(over: Parameters<typeof situationClaim>[0] = {}, now = T0) {
  const landed = await landAs(sql, alice, situationClaim({ reportedAt: T0, ...over }), now);
  return landed.record.id;
}

async function addEvidence(
  id: string,
  kind: string,
  occurredAt: string,
  actorKeyId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await sql`
    INSERT INTO conditions.report_evidence
      (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
    VALUES ('situation', ${id}, ${kind}, ${actorKeyId}, ${occurredAt},
            ${sql.json(details as never)})`;
}

interface DerivedRow {
  evidence_state: string | null;
  routing_eligible: boolean;
  confidence_score: number | null;
  corroborations: number;
  expires_at: Date | null;
  freshness_expires_at: string | null;
  revision: number;
}

async function readDerived(id: string): Promise<DerivedRow> {
  const rows = await sql<DerivedRow[]>`
    SELECT evidence_state, routing_eligible, confidence_score, corroborations, expires_at,
           record #>> '{freshness,expiresAt}' AS freshness_expires_at, revision
    FROM conditions.situation WHERE id = ${id}`;
  return rows[0]!;
}

describe("recomputeEvidence — no-op cases", () => {
  it("returns null for a non-existent situation", async () => {
    expect(await recomputeEvidence(sql, registry, "oc:situation:nope", T0)).toBeNull();
  }, 30_000);

  it("returns null and writes nothing for a crowd situation with zero evidence rows", async () => {
    const id = await landReport();
    await sql`DELETE FROM conditions.report_evidence WHERE record_id = ${id}`;
    const before = await readDerived(id);
    expect(await recomputeEvidence(sql, registry, id, "2026-07-12T08:05:00.000Z")).toBeNull();
    expect(await readDerived(id)).toEqual(before);
  }, 30_000);

  it("returns null for a feed situation even when it carries evidence rows", async () => {
    const feed = await seedFeedSituation(sql, "recompute-feed");
    await addEvidence(feed, "confirm", T0, bob.keyId);
    expect(await recomputeEvidence(sql, registry, feed, "2026-07-12T08:05:00.000Z")).toBeNull();
    const row = await readDerived(feed);
    expect(row.evidence_state).toBeNull();
    expect(row.routing_eligible).toBe(false);
    expect(row.expires_at).toBeNull();
  }, 30_000);
});

describe("recomputeEvidence — evidence lifecycle", () => {
  it("climbs self_reported → corroborated → externally_resolved, extending the expiry in place", async () => {
    const id = await landReport();

    const reported = await recomputeEvidence(sql, registry, id, "2026-07-12T08:05:00.000Z");
    expect(reported).toMatchObject({
      state: "self_reported",
      routingEligible: false,
      corroborations: 0,
      expiresAt: "2026-07-12T08:15:00.000Z",
    });
    expect(reported!.confidenceScore).toBeCloseTo(0.3, 10);
    expect(await readDerived(id)).toMatchObject({
      evidence_state: "self_reported",
      routing_eligible: false,
      corroborations: 0,
      expires_at: new Date("2026-07-12T08:15:00.000Z"),
      freshness_expires_at: "2026-07-12T08:15:00.000Z",
    });

    await addEvidence(id, "confirm", "2026-07-12T08:10:00.000Z", bob.keyId);
    const corroborated = await recomputeEvidence(sql, registry, id, "2026-07-12T08:12:00.000Z");
    // Incremental crowd confidence for one confirmation: 0.3 + (0.75 - 0.3) * (1 - 0.5).
    expect(corroborated!.confidenceScore).toBeCloseTo(0.525, 10);
    // The confirm at 08:10 plus the 15-minute obstruction lifetime, under the 2 h ceiling.
    expect(corroborated).toMatchObject({
      state: "corroborated",
      routingEligible: false,
      corroborations: 1,
      expiresAt: "2026-07-12T08:25:00.000Z",
    });
    expect(await readDerived(id)).toMatchObject({
      evidence_state: "corroborated",
      corroborations: 1,
      expires_at: new Date("2026-07-12T08:25:00.000Z"),
      freshness_expires_at: "2026-07-12T08:25:00.000Z",
    });

    await addEvidence(id, "reviewer_accept", "2026-07-12T08:20:00.000Z", null, {
      source: "reviewer",
      outcome: "confirmed",
    });
    const resolved = await recomputeEvidence(sql, registry, id, "2026-07-12T08:22:00.000Z");
    expect(resolved!.confidenceScore).toBeCloseTo(0.9, 10);
    expect(resolved).toMatchObject({
      state: "externally_resolved",
      routingEligible: true,
      expiresAt: "2026-07-12T08:35:00.000Z",
    });
    const row = await readDerived(id);
    expect(row).toMatchObject({ evidence_state: "externally_resolved", routing_eligible: true });
    // The expiry is derived, not content: no recompute wrote a revision.
    expect(row.revision).toBe(1);
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.situation_revision WHERE situation_id = ${id}`;
    expect(n).toBe(1);
  }, 30_000);

  it("counts a confirmation by the originator's own key in no corroboration", async () => {
    const id = await landReport();
    await addEvidence(id, "confirm", "2026-07-12T08:03:00.000Z", alice.keyId);
    await addEvidence(id, "confirm", "2026-07-12T08:04:00.000Z", bob.keyId);
    await addEvidence(id, "confirm", "2026-07-12T08:05:00.000Z", bob.keyId);
    const result = await recomputeEvidence(sql, registry, id, "2026-07-12T08:06:00.000Z");
    expect(result!.corroborations).toBe(1);
    expect((await readDerived(id)).corroborations).toBe(1);
  }, 30_000);

  it("negates on a reviewer rejection, expiring at the decision", async () => {
    const id = await landReport();
    await addEvidence(id, "reviewer_reject", "2026-07-12T08:05:00.000Z", null, {
      source: "reviewer",
      outcome: "rejected",
    });

    const result = await recomputeEvidence(sql, registry, id, "2026-07-12T08:06:00.000Z");
    expect(result).toMatchObject({
      state: "negated",
      routingEligible: false,
      expiresAt: "2026-07-12T08:05:00.000Z",
    });
    expect(result!.confidenceScore).toBeCloseTo(0.1, 10);
    expect(await readDerived(id)).toMatchObject({
      evidence_state: "negated",
      expires_at: new Date("2026-07-12T08:05:00.000Z"),
    });
  }, 30_000);

  it("takes the lifetime from the kind and type's crowd rules", async () => {
    const id = await landReport({ type: "accident" });
    const ttl = crowdRulesFor(registry, {
      class: "situation",
      kind: "incident",
      type: "accident",
    })!.ttlSec;
    expect(ttl).toBe(30 * 60);
    const result = await recomputeEvidence(sql, registry, id, "2026-07-12T08:01:00.000Z");
    expect(result!.expiresAt).toBe(new Date(Date.parse(T0) + ttl * 1000).toISOString());
  }, 30_000);

  it("counts a report's lifetime from when it was made, not when it arrived", async () => {
    const id = await landReport({ reportedAt: "2026-07-12T07:55:00.000Z" });
    const result = await recomputeEvidence(sql, registry, id, "2026-07-12T08:01:00.000Z");
    expect(result!.expiresAt).toBe("2026-07-12T08:10:00.000Z");
  }, 30_000);
});

describe("recomputeEvidence — concurrency (FOR UPDATE)", () => {
  it("blocks behind another transaction's row lock and then sees its committed evidence", async () => {
    const id = await landReport();

    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => (releaseLock = resolve));
    let signalAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => (signalAcquired = resolve));

    // tx1 takes the situation's row lock, then (while still holding it)
    // appends a reviewer_reject before committing — the exact interleaving
    // where a recompute WITHOUT the FOR UPDATE would read the pre-reject
    // ledger and commit a stale non-negated state last, masking the reject.
    const tx1 = sql.begin(async (tx) => {
      await tx`SELECT id FROM conditions.situation WHERE id = ${id} FOR UPDATE`;
      signalAcquired();
      await lockHeld;
      await tx`
        INSERT INTO conditions.report_evidence
          (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
        VALUES ('situation', ${id}, 'reviewer_reject', NULL, '2026-07-12T08:01:00.000Z',
                '{"source":"reviewer","outcome":"rejected"}'::jsonb)`;
    });

    await lockAcquired;
    let recomputeSettled = false;
    const recompute = recomputeEvidence(sql, registry, id, "2026-07-12T08:02:00.000Z").then(
      (result) => {
        recomputeSettled = true;
        return result;
      },
    );

    // While tx1 holds the row lock the recompute must be blocked, not running
    // on a stale snapshot.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(recomputeSettled).toBe(false);

    releaseLock();
    await tx1;
    const result = await recompute;
    expect(result!.state).toBe("negated");
    expect((await readDerived(id)).evidence_state).toBe("negated");
  }, 30_000);
});

describe("recomputeEvidence — replay determinism", () => {
  it("wiping the derived columns and recomputing at the same instant yields byte-equal results", async () => {
    const id = await landReport();
    await addEvidence(id, "confirm", "2026-07-12T08:03:00.000Z", bob.keyId);
    await addEvidence(id, "reviewer_accept", "2026-07-12T08:06:00.000Z", null, {
      source: "reviewer",
      outcome: "confirmed",
    });

    const NOW = "2026-07-12T08:08:00.000Z";
    const first = await recomputeEvidence(sql, registry, id, NOW);
    const firstRow = await readDerived(id);

    // Wipe the materialised outputs; the raw ledger stays authoritative.
    await sql`
      UPDATE conditions.situation SET
        evidence_state = NULL, routing_eligible = false, confidence_score = NULL,
        corroborations = 0, expires_at = NULL,
        record = record #- '{freshness,expiresAt}'
      WHERE id = ${id}`;

    const second = await recomputeEvidence(sql, registry, id, NOW);
    expect(second).toEqual(first);
    expect(await readDerived(id)).toEqual(firstRow);
  }, 30_000);
});
