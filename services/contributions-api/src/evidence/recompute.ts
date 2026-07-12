import type postgres from "postgres";
import { evaluateEvidence, type EvidencePolicyResult } from "@openconditions/core";
import { evidenceRowsToLedger, type ReportEvidenceRow } from "@openconditions/contrib-core";
import { evidencePolicyFor } from "@openconditions/roads";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

interface ObservationRow {
  type: string | null;
  origin: { kind?: string } | null;
}

interface EvidenceDbRow {
  id: string;
  observation_id: string;
  evidence_kind: string;
  actor_key_id: string | null;
  source_id: string | null;
  occurred_at: Date;
  details: unknown;
}

/**
 * Recompute an observation's materialized evidence state from its authoritative
 * `report_evidence` ledger and persist it. Reads the observation (type/origin)
 * and all its evidence rows in ONE transaction, projects the rows into core's
 * replayable ledger, builds the per-(type, origin) policy, runs the pure
 * `evaluateEvidence`, and writes back `evidence_state` / `routing_eligible` /
 * `confidence_score` / `expires_at`.
 *
 * `now` is the evaluation instant, threaded through for determinism: the same
 * ledger recomputed at the same `now` always yields byte-identical results.
 *
 * Returns `null` (and writes nothing) when the observation does not exist or
 * has no evidence rows.
 *
 * Pass an existing transaction handle as `tx` to COMPOSE the recompute inside a
 * larger transaction (e.g. a corroboration that appends an evidence row and then
 * recomputes atomically). Called standalone (no `tx`) it opens its own
 * transaction, preserving the FOR UPDATE row-lock and replay behaviour.
 */
export async function recomputeEvidence(
  sql: Sql,
  observationId: string,
  now: string,
  tx?: Tx
): Promise<EvidencePolicyResult | null> {
  if (tx !== undefined) {
    return recomputeWithin(tx, observationId, now);
  }
  return sql.begin((t) => recomputeWithin(t, observationId, now));
}

async function recomputeWithin(
  tx: Tx,
  observationId: string,
  now: string
): Promise<EvidencePolicyResult | null> {
  // FOR UPDATE serializes concurrent recomputes for the same observation:
  // without it, a recompute that read the ledger BEFORE a just-committed
  // evidence row (e.g. a reviewer_reject) could commit its stale result last
  // and mask the newer evidence until the next recompute.
  const observationRows = await tx<ObservationRow[]>`
    SELECT type, origin FROM conditions.observations WHERE id = ${observationId} FOR UPDATE
  `;
  const observation = observationRows[0];
  if (observation === undefined) {
    return null;
  }

  const evidenceRows = await tx<EvidenceDbRow[]>`
    SELECT id, observation_id, evidence_kind, actor_key_id, source_id, occurred_at, details
    FROM conditions.report_evidence
    WHERE observation_id = ${observationId}
    ORDER BY occurred_at, id
  `;
  if (evidenceRows.length === 0) {
    return null;
  }

  const rows: ReportEvidenceRow[] = evidenceRows.map((row) => ({
    id: row.id,
    observationId: row.observation_id,
    evidenceKind: row.evidence_kind,
    actorKeyId: row.actor_key_id,
    sourceId: row.source_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    details: row.details,
  }));

  const ledger = evidenceRowsToLedger(rows, now);
  const origin = observation.origin?.kind === "crowd" ? "crowd" : "feed";
  const policy = evidencePolicyFor(observation.type ?? "", origin);
  const result = evaluateEvidence(ledger, policy);

  await tx`
    UPDATE conditions.observations SET
      evidence_state = ${result.state},
      routing_eligible = ${result.routingEligible},
      confidence_score = ${result.confidenceScore},
      expires_at = ${result.expiresAt}
    WHERE id = ${observationId}
  `;

  return result;
}
