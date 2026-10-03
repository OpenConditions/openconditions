import { updateReliability } from "@openconditions/core";
import type { EvidenceState, Registry } from "@openconditions/model";
import type postgres from "postgres";
import { lockCrowd } from "../crowd.js";
import { recomputeEvidence, recomputeObservationEvidence } from "../evidence/recompute.js";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

/** An external resolution of a crowd report's truth. */
export interface ExternalResolution {
  source: "official" | "reviewer" | "objective";
  outcome: "confirmed" | "rejected";
  /**
   * The record that justified this resolution — for an `official`
   * cross-validation, the agreeing FEED situation. External resolution is the
   * ONLY path to routing eligibility, so which record said so must be
   * auditable: it is recorded as `report_evidence.source_id` (the feed) plus
   * `details.matchedRecord` (the exact record). A reviewer or objective
   * resolution has none.
   */
  matchedRecord?: { class: string; id: string; sourceId: string };
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
  resolution: ExternalResolution,
): "official_match" | "reviewer_accept" | "reviewer_reject" {
  if (resolution.outcome === "rejected") return "reviewer_reject";
  return resolution.source === "reviewer" ? "reviewer_accept" : "official_match";
}

/**
 * Apply an EXTERNAL resolution (official feed match, reviewer decision, or
 * objective outcome) to a crowd situation or crowd observation (`target`: a
 * situation id, or the record it names) — the ONE place reporter
 * reputation is trained. Everything runs in a single transaction under the
 * crowd lock, holding FOR UPDATE on the situation:
 *
 * 1. Append the external `report_evidence` row, guarded by NOT EXISTS on the
 *    same (situation, source, outcome) so a double resolution is a no-op.
 * 2. Recompute the situation's evidence in-tx: a confirmation makes it
 *    `externally_resolved` (the only routing-eligible state); a rejection
 *    negates.
 * 3. Update Beta posteriors via core's `updateReliability` for the
 *    ORIGINATING reporter (the key on the first `report` row) and every
 *    DISTINCT confirming key whose confirm came STRICTLY BEFORE the report
 *    was first settled (the earliest external row, or `now` on the first
 *    resolution). A confirm that postdates the first resolution earned no
 *    honest signal and is never trained. Confirmed → +α, rejected → +β.
 *    Pre-cutoff confirmers also get `corroborated_count + 1` on a confirmed
 *    resolution.
 *
 * BINDING: only these externally RESOLVED outcomes touch any posterior.
 * Crowd corroboration alone changes evidence state but never reputation, so
 * colluding keys cannot train one another.
 *
 * Pass a transaction handle as `tx` to COMPOSE the resolution inside a larger
 * transaction (e.g. a reviewer reject that resolves then tombstones); the
 * caller then holds the crowd lock.
 *
 * Returns null when the situation does not exist.
 */
export async function applyExternalResolution(
  sql: Sql,
  registry: Registry,
  target: string | CrowdRecordRef,
  resolution: ExternalResolution,
  now: string,
  tx?: Tx,
): Promise<ResolutionResult | null> {
  const ref: CrowdRecordRef =
    typeof target === "string" ? { class: "situation", id: target } : target;
  if (tx !== undefined) return resolveWithin(tx, sql, registry, ref, resolution, now);
  return sql.begin(async (t) => {
    await lockCrowd(t);
    return resolveWithin(t, sql, registry, ref, resolution, now);
  });
}

/** A crowd record evidence is kept for: a situation, or an observation by its record id. */
export interface CrowdRecordRef {
  class: "situation" | "observation";
  id: string;
}

async function resolveWithin(
  tx: Tx,
  sql: Sql,
  registry: Registry,
  ref: CrowdRecordRef,
  resolution: ExternalResolution,
  now: string,
): Promise<ResolutionResult | null> {
  const situationId = ref.id;
  const recordClass = ref.class;
  const [situation] =
    recordClass === "situation"
      ? await tx<{ evidence_state: EvidenceState; routing_eligible: boolean }[]>`
          SELECT evidence_state, routing_eligible FROM conditions.situation
          WHERE id = ${situationId} FOR UPDATE
        `
      : await tx<{ evidence_state: EvidenceState; routing_eligible: boolean }[]>`
          SELECT evidence_state, false AS routing_eligible FROM conditions.observation_latest
          WHERE source_id = 'crowd' AND record->>'id' = ${situationId} FOR UPDATE
        `;
  if (situation === undefined) return null;

  const kind = evidenceKindFor(resolution);
  const matched = resolution.matchedRecord;
  const details = {
    source: resolution.source,
    outcome: resolution.outcome,
    ...(matched === undefined ? {} : { matchedRecord: { class: matched.class, id: matched.id } }),
  };

  const [prior] = await tx<{ first_external: Date | null }[]>`
    SELECT MIN(occurred_at) AS first_external FROM conditions.report_evidence
    WHERE record_class = ${recordClass} AND record_id = ${situationId}
      AND evidence_kind IN ('official_match', 'reviewer_accept', 'reviewer_reject')
  `;
  const cutoffIso =
    prior?.first_external == null ? now : new Date(prior.first_external).toISOString();

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO conditions.report_evidence
      (record_class, record_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
    SELECT ${recordClass}, ${situationId}, ${kind}, NULL, ${matched?.sourceId ?? null}, ${now},
           ${tx.json(details)}
    WHERE NOT EXISTS (
      SELECT 1 FROM conditions.report_evidence
      WHERE record_class = ${recordClass} AND record_id = ${situationId}
        AND evidence_kind = ${kind}
        AND details->>'source' = ${resolution.source}
        AND details->>'outcome' = ${resolution.outcome}
    )
    RETURNING id
  `;
  if (inserted.length === 0) {
    return {
      evidenceState: situation.evidence_state,
      routingEligible: situation.routing_eligible,
    };
  }

  const result =
    recordClass === "situation"
      ? await recomputeEvidence(sql, registry, situationId, now, tx)
      : await recomputeObservationEvidence(tx, registry, situationId, now);

  const [originator] = await tx<{ actor_key_id: string | null }[]>`
    SELECT actor_key_id FROM conditions.report_evidence
    WHERE record_class = ${recordClass} AND record_id = ${situationId} AND evidence_kind = 'report'
    ORDER BY occurred_at, id
    LIMIT 1
  `;
  const originatingKey = originator?.actor_key_id ?? null;

  const confirmerRows = await tx<{ actor_key_id: string }[]>`
    SELECT DISTINCT actor_key_id FROM conditions.report_evidence
    WHERE record_class = ${recordClass} AND record_id = ${situationId}
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
        resolution.outcome,
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
    evidenceState: result?.state ?? situation.evidence_state,
    routingEligible: result?.routingEligible ?? situation.routing_eligible,
  };
}
