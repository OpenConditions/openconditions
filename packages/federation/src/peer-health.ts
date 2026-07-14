/**
 * Per-peer OPERATIONS (health) score and its storage.
 *
 * A pinned peer accrues availability successes/failures and per-class failure
 * counts (signature, replay, schema, rate). {@link computePeerHealth} reduces a
 * row to a 0..1 health score plus the reasons behind any degradation.
 *
 * BINDING (ADR §8): PEER HEALTH IS SEPARATE FROM EVENT TRUTH. This score informs
 * GOVERNANCE, the transport RATE POLICY, and a reviewer NOTIFICATION — nothing
 * else. It MUST NOT feed evidence_state, confidence_score, routing eligibility,
 * or reporter reputation, and a misbehaving peer's already-received events are
 * NEVER re-judged from it. A DATA-QUALITY downgrade of an event requires an
 * EXTERNALLY RESOLVED outcome (official feed / objective rule / accountable
 * review), never this signal. A grep-guard test asserts no evidence/reputation/
 * confidence/routing module imports this file.
 */
import type postgres from "postgres";

type Sql = postgres.Sql;

/** A per-class transport failure recorded against a peer's health. */
export type PeerHealthFailure = "signature" | "replay" | "schema" | "rate";

/** The stored per-peer health counters. */
export interface PeerHealthRow {
  peerId: string;
  availabilityOk: number;
  availabilityFail: number;
  signatureFailures: number;
  replayFailures: number;
  schemaFailures: number;
  rateViolations: number;
  effectiveTierUntil: Date | null;
  updatedAt: Date;
}

const FAILURE_COLUMN: Record<PeerHealthFailure, string> = {
  signature: "signature_failures",
  replay: "replay_failures",
  schema: "schema_failures",
  rate: "rate_violations",
};

interface RawHealthRow {
  peer_id: string;
  availability_ok: number;
  availability_fail: number;
  signature_failures: number;
  replay_failures: number;
  schema_failures: number;
  rate_violations: number;
  effective_tier_until: Date | null;
  updated_at: Date;
}

function toRow(raw: RawHealthRow): PeerHealthRow {
  return {
    peerId: raw.peer_id,
    availabilityOk: Number(raw.availability_ok),
    availabilityFail: Number(raw.availability_fail),
    signatureFailures: Number(raw.signature_failures),
    replayFailures: Number(raw.replay_failures),
    schemaFailures: Number(raw.schema_failures),
    rateViolations: Number(raw.rate_violations),
    effectiveTierUntil: raw.effective_tier_until,
    updatedAt: raw.updated_at,
  };
}

/** Reads a peer's health row, or null when the peer has no recorded activity. */
export async function getPeerHealth(sql: Sql, peerId: string): Promise<PeerHealthRow | null> {
  const rows = await sql<RawHealthRow[]>`
    SELECT * FROM conditions.federation_peer_health WHERE peer_id = ${peerId}`;
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Records the outcome of an outbound poll of a peer (availability). Success
 * increments availability_ok; failure increments availability_fail. Wiring note:
 * call from the consumer-side pull of a peer's /peer/outbox on success/failure.
 */
export async function recordAvailability(
  sql: Sql,
  peerId: string,
  ok: boolean,
  now: string
): Promise<void> {
  if (ok) {
    await sql`
      INSERT INTO conditions.federation_peer_health (peer_id, availability_ok, updated_at)
      VALUES (${peerId}, 1, ${now})
      ON CONFLICT (peer_id) DO UPDATE
        SET availability_ok = conditions.federation_peer_health.availability_ok + 1,
            updated_at = ${now}`;
  } else {
    await sql`
      INSERT INTO conditions.federation_peer_health (peer_id, availability_fail, updated_at)
      VALUES (${peerId}, 1, ${now})
      ON CONFLICT (peer_id) DO UPDATE
        SET availability_fail = conditions.federation_peer_health.availability_fail + 1,
            updated_at = ${now}`;
  }
}

/**
 * Records a transport failure of `kind` against a peer's health. The
 * signature/replay/schema failures originate on the inbox signature-verify and
 * event-ingest path; a rate violation is recorded when the limiter refuses a
 * request. This is a TRANSPORT signal only — it never touches the peer's
 * already-accepted events.
 */
export async function recordPeerFailure(
  sql: Sql,
  peerId: string,
  kind: PeerHealthFailure,
  now: string,
  count = 1
): Promise<void> {
  if (count <= 0) return;
  const column = FAILURE_COLUMN[kind];
  await sql`
    INSERT INTO conditions.federation_peer_health (peer_id, ${sql(column)}, updated_at)
    VALUES (${peerId}, ${count}, ${now})
    ON CONFLICT (peer_id) DO UPDATE
      SET ${sql(column)} = conditions.federation_peer_health.${sql(column)} + ${count},
          updated_at = ${now}`;
}

/**
 * Persists a transport-only tier-downgrade cooldown marker for observability
 * (the authoritative rate downgrade lives in the in-memory limiter). Recording
 * it here does NOT change how the peer's events are trusted.
 */
export async function setEffectiveTierUntil(
  sql: Sql,
  peerId: string,
  until: string | null,
  now: string
): Promise<void> {
  await sql`
    INSERT INTO conditions.federation_peer_health (peer_id, effective_tier_until, updated_at)
    VALUES (${peerId}, ${until}, ${now})
    ON CONFLICT (peer_id) DO UPDATE
      SET effective_tier_until = ${until}, updated_at = ${now}`;
}

/** A computed health verdict. */
export interface PeerHealth {
  /** 0..1, higher is healthier. */
  score: number;
  /** Named reasons behind any degradation; empty for a clean peer. */
  reasons: string[];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Reduces a peer's counters to a 0..1 health score and the reasons behind any
 * degradation. Health = availability blended with an integrity term over the
 * per-class failure rate. A peer with no recorded activity scores a neutral 1.
 *
 * This is a TRANSPORT/GOVERNANCE signal — see the file header. It is never a
 * statement about the truth of the peer's events.
 */
export function computePeerHealth(row: {
  availabilityOk: number;
  availabilityFail: number;
  signatureFailures: number;
  replayFailures: number;
  schemaFailures: number;
  rateViolations: number;
}): PeerHealth {
  const attempts = row.availabilityOk + row.availabilityFail;
  const availabilityScore = attempts === 0 ? 1 : row.availabilityOk / attempts;
  const failures =
    row.signatureFailures + row.replayFailures + row.schemaFailures + row.rateViolations;
  const integrityDenom = attempts + failures;
  const integrityScore = integrityDenom === 0 ? 1 : 1 - failures / integrityDenom;

  const score = clamp01(0.5 * availabilityScore + 0.5 * integrityScore);

  const reasons: string[] = [];
  if (attempts > 0 && availabilityScore < 0.99) reasons.push("low_availability");
  if (row.signatureFailures > 0) reasons.push("signature_failures");
  if (row.replayFailures > 0) reasons.push("replay_failures");
  if (row.schemaFailures > 0) reasons.push("schema_failures");
  if (row.rateViolations > 0) reasons.push("rate_violations");

  return { score, reasons };
}
