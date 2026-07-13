/**
 * The reviewer accept/reject decisions — the accountable, post-hoc resolution of
 * a flagged crowd observation. Both call T7's {@link applyExternalResolution}
 * (the ONE place reporter reputation is trained); neither re-implements the
 * resolution or reputation math.
 *
 * accept → the observation is externally CONFIRMED: it flips to
 * `externally_resolved`, becomes routing-eligible, its pre-settlement confirmers
 * are trained `confirmed`, and its open flag is cleared.
 *
 * reject → the observation is externally REJECTED and TOMBSTONED in ONE
 * transaction holding FOR UPDATE: the resolution negates it and trains
 * `rejected`, then the public row is scrubbed to a minimal deletion record
 * (`status = 'archived'`, text/attributes/subject scrubbed, a tombstone marker
 * left in `attributes`). The observations table `geom` is NOT NULL, so geometry
 * cannot be nulled; a road-condition point/line is not itself PII, so it is
 * kept. `id`/`canonical_id`/`instance_id`/`phenomenon_fingerprint` are kept for
 * federation dedup + tombstone propagation. The `report_evidence` ledger is
 * RETAINED for audit; only the wire-level federation tombstone (plan 2) carries
 * id + canonicalId + a deletion flag, and the local ledger never federates.
 */
import type postgres from "postgres";
import type { EvidenceState } from "@openconditions/core";
import { applyExternalResolution } from "../reputation/resolve.js";

type Sql = postgres.Sql;

export type DecisionOutcome =
  | { code: 404; error: string }
  | { code: 409; error: string }
  | {
      code: 200;
      observationId: string;
      evidenceState: EvidenceState;
      routingEligible: boolean;
      tombstoned?: boolean;
    };

interface GateRow {
  status: string;
  evidence_state: EvidenceState | null;
}

/** Load and lock the observation row, or null when it does not exist. */
async function loadLocked(
  tx: postgres.TransactionSql,
  observationId: string
): Promise<GateRow | null> {
  const rows = await tx<GateRow[]>`
    SELECT status, evidence_state FROM conditions.observations
    WHERE id = ${observationId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Accept a flagged observation: confirm it externally, make it routing-eligible,
 * train reputation, and clear its open flag.
 *
 * Gate: 404 when missing; 409 when not active or already externally settled
 * (`externally_resolved`/`negated`) — one does not "accept" something peers or a
 * prior review already resolved.
 */
export async function acceptObservation(
  sql: Sql,
  observationId: string,
  now: string
): Promise<DecisionOutcome> {
  return sql.begin(async (tx) => {
    const row = await loadLocked(tx, observationId);
    if (row === null) {
      return { code: 404, error: "observation not found" };
    }
    if (
      row.status !== "active" ||
      row.evidence_state === "externally_resolved" ||
      row.evidence_state === "negated"
    ) {
      return { code: 409, error: "observation already resolved or archived" };
    }

    const resolution = await applyExternalResolution(
      sql,
      observationId,
      { source: "reviewer", outcome: "confirmed" },
      now,
      tx
    );

    await tx`
      UPDATE conditions.observations SET flagged_at = NULL WHERE id = ${observationId}
    `;

    return {
      code: 200,
      observationId,
      evidenceState: resolution!.evidenceState,
      routingEligible: resolution!.routingEligible,
    };
  });
}

/**
 * Reject a flagged observation: negate it externally, train reputation, then
 * tombstone the public row (archive + scrub). All in ONE transaction.
 *
 * Gate: 404 when missing; 409 ONLY when already tombstoned (`status` is not
 * `active`). A reject is allowed on an active observation REGARDLESS of evidence
 * state — including one peers already negated — so a community-negated, flagged
 * observation can always be tombstoned and never gets stuck unreachable (a GDPR
 * deletion-reachability requirement). Re-training is idempotent: T7's
 * `applyExternalResolution` guards the duplicate `reviewer_reject` row.
 */
export async function rejectObservation(
  sql: Sql,
  observationId: string,
  now: string
): Promise<DecisionOutcome> {
  return sql.begin(async (tx) => {
    const row = await loadLocked(tx, observationId);
    if (row === null) {
      return { code: 404, error: "observation not found" };
    }
    if (row.status !== "active") {
      return { code: 409, error: "observation already archived" };
    }

    const resolution = await applyExternalResolution(
      sql,
      observationId,
      { source: "reviewer", outcome: "rejected" },
      now,
      tx
    );

    const tombstoneMarker = { tombstone: true, reason: "reviewer_reject", at: now };
    await tx`
      UPDATE conditions.observations SET
        status = 'archived',
        tombstone_reason = 'retracted_as_wrong',
        flagged_at = NULL,
        headline = NULL,
        description = NULL,
        subject = NULL,
        label = NULL,
        severity = NULL,
        severity_level = NULL,
        attributes = ${tx.json(tombstoneMarker)},
        origin = ${tx.json({ kind: "crowd" })}
      WHERE id = ${observationId}
    `;

    return {
      code: 200,
      observationId,
      evidenceState: resolution!.evidenceState,
      routingEligible: resolution!.routingEligible,
      tombstoned: true,
    };
  });
}
