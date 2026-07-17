import type postgres from "postgres";
import { updateReliability, type EvidenceState } from "@openconditions/core";
import { recomputeEvidence } from "../evidence/recompute.js";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

/** An external resolution of a crowd observation's truth. */
export interface ExternalResolution {
  source: "official" | "reviewer" | "objective";
  outcome: "confirmed" | "rejected";
  /**
   * The concrete observation that justified this resolution — for an `official`
   * cross-validation, the matched FEED row. External resolution is the ONLY
   * path to `routing_eligible`, so which row said so must be auditable: without
   * it a routed report records "an official feed confirmed this" and nothing
   * that can be checked, disputed or traced when the feed is later corrected.
   * Recorded as `report_evidence.source_id` (the feed's source) plus
   * `details.matchedObservationId` (the exact row). Optional: a reviewer or
   * objective resolution has no matched row.
   */
  matchedObservation?: { id: string; source: string };
}

export interface ResolutionResult {
  evidenceState: EvidenceState;
  routingEligible: boolean;
}

/**
 * Map a resolution onto the `report_evidence.evidence_kind` CHECK set. The
 * kind carries the ledger semantics (confirmation vs rejection); the TRUE
 * source always travels in `details.source`, so an official/objective
 * rejection stored as `reviewer_reject` stays fully reconstructable.
 */
function evidenceKindFor(
  resolution: ExternalResolution
): "official_match" | "reviewer_accept" | "reviewer_reject" {
  if (resolution.outcome === "rejected") {
    return "reviewer_reject";
  }
  return resolution.source === "reviewer" ? "reviewer_accept" : "official_match";
}

/**
 * Apply an EXTERNAL resolution (official feed match, reviewer decision, or
 * objective outcome) to a crowd observation — the ONE place reporter
 * reputation is trained. Everything runs in a single transaction holding
 * FOR UPDATE on the observation:
 *
 * 1. Append the external `report_evidence` row (kind per
 *    {@link evidenceKindFor}, `details = { source, outcome }` plus
 *    `matchedObservationId` and `source_id` when the caller names the row that
 *    justified it, occurred_at = `now`), guarded by NOT EXISTS on the same
 *    (observation, source, outcome) so a double resolution is a no-op replay.
 * 2. Recompute the observation's evidence state in-tx: an external
 *    confirmation flips it to `externally_resolved` (the only routing-eligible
 *    state); a rejection negates.
 * 3. Update Beta posteriors via core's `updateReliability` for the
 *    ORIGINATING reporter (the key on the first `report` evidence row — always
 *    trained) and every DISTINCT confirming key whose confirm occurred_at is
 *    STRICTLY BEFORE the observation was first settled (the MIN occurred_at of
 *    any pre-existing external row, or `now` on the first resolution). A
 *    confirm that postdates the first resolution earned no honest signal and
 *    is never trained — not by this resolution nor by any later distinct-source
 *    one. Confirmed → +α, rejected → +β. Pre-cutoff confirmers additionally
 *    get `corroborated_count + 1` on a confirmed resolution.
 *
 * BINDING: only these externally RESOLVED outcomes touch any posterior. Crowd
 * corroboration alone changes evidence state but never reputation, so
 * colluding keys cannot train one another. Inactivity decay (`shrinkToward`
 * toward the cohort prior) is a separate read-time/maintenance concern and is
 * deliberately NOT applied here.
 *
 * Idempotence: the posterior update only runs when step 1 actually inserted
 * the evidence row. A replay with the same (observation, source, outcome)
 * changes nothing and returns the current derived state. A resolution with a
 * DIFFERENT source or outcome is new evidence and trains again — the ledger
 * keeps both rows and the recompute lets the latest external entry decide.
 *
 * Pass an existing transaction handle as `tx` to COMPOSE the resolution inside a
 * larger transaction (e.g. a reviewer reject that resolves then tombstones the
 * observation atomically). Called standalone (no `tx`) it opens its own
 * transaction, preserving the FOR UPDATE row-lock and replay behaviour.
 *
 * Returns null when the observation does not exist.
 */
export async function applyExternalResolution(
  sql: Sql,
  observationId: string,
  resolution: ExternalResolution,
  now: string,
  tx?: Tx
): Promise<ResolutionResult | null> {
  if (tx !== undefined) {
    return resolveWithin(tx, sql, observationId, resolution, now);
  }
  return sql.begin((t) => resolveWithin(t, sql, observationId, resolution, now));
}

async function resolveWithin(
  tx: Tx,
  sql: Sql,
  observationId: string,
  resolution: ExternalResolution,
  now: string
): Promise<ResolutionResult | null> {
  const observationRows = await tx<{ id: string }[]>`
    SELECT id FROM conditions.observations WHERE id = ${observationId} FOR UPDATE
  `;
  if (observationRows[0] === undefined) {
    return null;
  }

  const kind = evidenceKindFor(resolution);
  // The matched row travels in `details.matchedObservationId` + `source_id`, but
  // NOT in the replay guard below — that stays keyed on (source, outcome), so a
  // second official match from a different feed remains the same no-op replay it
  // has always been. One official confirmation routes; the first one is recorded.
  const details = {
    source: resolution.source,
    outcome: resolution.outcome,
    ...(resolution.matchedObservation !== undefined
      ? { matchedObservationId: resolution.matchedObservation.id }
      : {}),
  };
  const sourceId = resolution.matchedObservation?.source ?? null;

  // The reputation cutoff is the FIRST external resolution's occurred_at,
  // computed BEFORE appending this one. Only confirmers who acted strictly
  // before the observation was ever settled earned honest signal; a confirm
  // that postdates the first resolution must never be trained — not by this
  // resolution nor by any later distinct-source one. On the first resolution
  // no external row exists yet, so the row we are about to append at `now`
  // becomes the cutoff.
  const priorExternalRows = await tx<{ first_external: Date | null }[]>`
    SELECT MIN(occurred_at) AS first_external FROM conditions.report_evidence
    WHERE observation_id = ${observationId}
      AND evidence_kind IN ('official_match', 'reviewer_accept', 'reviewer_reject')
  `;
  const priorExternal = priorExternalRows[0]?.first_external ?? null;
  const cutoffIso = priorExternal === null ? now : new Date(priorExternal).toISOString();

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO conditions.report_evidence
      (observation_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
    SELECT ${observationId}, ${kind}, NULL, ${sourceId}, ${now}, ${tx.json(details)}
    WHERE NOT EXISTS (
      SELECT 1 FROM conditions.report_evidence
      WHERE observation_id = ${observationId}
        AND evidence_kind = ${kind}
        AND details->>'source' = ${resolution.source}
        AND details->>'outcome' = ${resolution.outcome}
    )
    RETURNING id
  `;

  if (inserted.length === 0) {
    const current = await tx<{ evidence_state: EvidenceState; routing_eligible: boolean }[]>`
      SELECT evidence_state, routing_eligible FROM conditions.observations
      WHERE id = ${observationId}
    `;
    return {
      evidenceState: current[0]!.evidence_state,
      routingEligible: current[0]!.routing_eligible,
    };
  }

  const result = await recomputeEvidence(sql, observationId, now, tx);

  const originatorRows = await tx<{ actor_key_id: string | null }[]>`
    SELECT actor_key_id FROM conditions.report_evidence
    WHERE observation_id = ${observationId} AND evidence_kind = 'report'
    ORDER BY occurred_at, id
    LIMIT 1
  `;
  const originatingKey = originatorRows[0]?.actor_key_id ?? null;

  const confirmerRows = await tx<{ actor_key_id: string }[]>`
    SELECT DISTINCT actor_key_id FROM conditions.report_evidence
    WHERE observation_id = ${observationId}
      AND evidence_kind = 'confirm'
      AND actor_key_id IS NOT NULL
      AND occurred_at < ${cutoffIso}::timestamptz
  `;
  const confirmerKeys = confirmerRows
    .map((row) => row.actor_key_id)
    .filter((key) => key !== originatingKey);

  const affectedKeys = [...new Set([originatingKey, ...confirmerKeys])]
    .filter((key): key is string => key !== null)
    .sort();

  if (affectedKeys.length > 0) {
    // Ordered FOR UPDATE keeps concurrent resolutions touching overlapping
    // reporter sets deadlock-free; keys without a reporter row are skipped.
    const reporters = await tx<
      { key_id: string; reputation_alpha: number; reputation_beta: number }[]
    >`
      SELECT key_id, reputation_alpha, reputation_beta FROM conditions.reporter
      WHERE key_id = ANY(${affectedKeys})
      ORDER BY key_id
      FOR UPDATE
    `;
    for (const reporter of reporters) {
      const posterior = updateReliability(
        { alpha: reporter.reputation_alpha, beta: reporter.reputation_beta },
        resolution.outcome
      );
      await tx`
        UPDATE conditions.reporter
        SET reputation_alpha = ${posterior.alpha}, reputation_beta = ${posterior.beta}
        WHERE key_id = ${reporter.key_id}
      `;
    }
  }

  if (resolution.outcome === "confirmed" && confirmerKeys.length > 0) {
    await tx`
      UPDATE conditions.reporter
      SET corroborated_count = corroborated_count + 1
      WHERE key_id = ANY(${confirmerKeys})
    `;
  }

  return {
    evidenceState: result!.state,
    routingEligible: result!.routingEligible,
  };
}
