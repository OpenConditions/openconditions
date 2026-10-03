import {
  crowdEvidencePolicy,
  evidenceRowsToLedger,
  type ReportEvidenceRow,
} from "@openconditions/contrib-core";
import { type EvidencePolicyResult, evaluateEvidence } from "@openconditions/core";
import { crowdRulesFor, type Registry } from "@openconditions/model";
import { refreshFused } from "@openconditions/storage";
import type postgres from "postgres";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

interface EvidenceDbRow {
  id: string;
  evidence_kind: string;
  actor_key_id: string | null;
  source_id: string | null;
  occurred_at: Date;
  details: unknown;
}

/** An evaluation plus the distinct keys that corroborated the report. */
export type EvidenceResult = EvidencePolicyResult & { corroborations: number };

/**
 * Recompute a crowd situation's evidence summary from its authoritative
 * `report_evidence` ledger and persist it. Reads the situation and all its
 * evidence rows in ONE transaction, projects the rows into core's replayable
 * ledger, builds the policy from the kind's crowd rules, runs the pure
 * `evaluateEvidence`, and writes back `evidence_state`, `routing_eligible`,
 * `confidence_score`, `corroborations` and the expiry, in `expires_at` and
 * the record's `freshness.expiresAt` alike — a peer's report keeps its
 * stated expiry and lives at least that long here. The expiry is derived,
 * not content: it writes no revision.
 *
 * `now` is the evaluation instant, threaded through for determinism: the same
 * ledger recomputed at the same `now` always yields byte-identical results.
 *
 * Returns `null` (and writes nothing) when the situation does not exist, is
 * not a crowd report (a feed record's lifetime is its source's), its kind
 * takes no crowd reports, or it has no evidence rows.
 *
 * Pass an existing transaction handle as `tx` to COMPOSE the recompute inside a
 * larger transaction. Called standalone it opens its own transaction,
 * preserving the FOR UPDATE row-lock and replay behaviour.
 */
export async function recomputeEvidence(
  sql: Sql,
  registry: Registry,
  situationId: string,
  now: string,
  tx?: Tx,
): Promise<EvidenceResult | null> {
  if (tx !== undefined) return recomputeWithin(tx, registry, situationId, now);
  return sql.begin((t) => recomputeWithin(t, registry, situationId, now));
}

async function recomputeWithin(
  tx: Tx,
  registry: Registry,
  situationId: string,
  now: string,
): Promise<EvidenceResult | null> {
  // FOR UPDATE serializes concurrent recomputes for the same situation:
  // without it, a recompute that read the ledger BEFORE a just-committed
  // evidence row (e.g. a reviewer_reject) could commit its stale result last
  // and mask the newer evidence until the next recompute.
  const [situation] = await tx<
    { kind: string; type: string; origin: string; peer_copy: boolean }[]
  >`
    SELECT kind, type, origin,
           jsonb_array_length(COALESCE(record #> '{provenance,originChain}', '[]'::jsonb)) > 0
             AS peer_copy
    FROM conditions.situation WHERE id = ${situationId} FOR UPDATE
  `;
  if (situation === undefined || situation.origin !== "crowd") return null;
  const rules = crowdRulesFor(registry, {
    class: "situation",
    kind: situation.kind,
    type: situation.type,
  });
  if (rules === undefined) return null;

  const evaluated = await evaluate(tx, "situation", situationId, rules, now);
  if (evaluated === null) return null;
  const { result, corroborations } = evaluated;

  if (situation.peer_copy) {
    // A peer's report lives as long as its own instance says (its evidence
    // there may extend it), longer when the evidence here does, and ends
    // when the evidence here negates it. Its stated expiry stays the peer's.
    const [row] = await tx<{ expires_at: Date }[]>`
      UPDATE conditions.situation SET
        evidence_state = ${result.state},
        routing_eligible = ${result.routingEligible},
        confidence_score = ${result.confidenceScore},
        corroborations = ${corroborations},
        expires_at = CASE WHEN ${result.state} = 'negated' THEN ${result.expiresAt}::timestamptz
          ELSE GREATEST(${result.expiresAt}::timestamptz,
                        (record #>> '{freshness,expiresAt}')::timestamptz) END
      WHERE id = ${situationId}
      RETURNING expires_at
    `;
    return { ...result, expiresAt: row!.expires_at.toISOString(), corroborations };
  }
  await tx`
    UPDATE conditions.situation SET
      evidence_state = ${result.state},
      routing_eligible = ${result.routingEligible},
      confidence_score = ${result.confidenceScore},
      corroborations = ${corroborations},
      expires_at = ${result.expiresAt},
      record = jsonb_set(record, '{freshness,expiresAt}', to_jsonb(${result.expiresAt}::text))
    WHERE id = ${situationId}
  `;
  return { ...result, corroborations };
}

/**
 * Evaluates one crowd record's ledger under its crowd rules: the evidence
 * state, its lifetime, and how many distinct keys besides the reporter's
 * confirmed it. Null when the record has no evidence rows.
 */
async function evaluate(
  tx: Tx,
  recordClass: "situation" | "observation",
  recordId: string,
  rules: NonNullable<ReturnType<typeof crowdRulesFor>>,
  now: string,
): Promise<{ result: EvidencePolicyResult; corroborations: number } | null> {
  const evidenceRows = await tx<EvidenceDbRow[]>`
    SELECT id, evidence_kind, actor_key_id, source_id, occurred_at, details
    FROM conditions.report_evidence
    WHERE record_class = ${recordClass} AND record_id = ${recordId} AND component_key = ''
    ORDER BY occurred_at, id
  `;
  if (evidenceRows.length === 0) return null;
  const rows: ReportEvidenceRow[] = evidenceRows.map((row) => ({
    id: row.id,
    evidenceKind: row.evidence_kind,
    actorKeyId: row.actor_key_id,
    sourceId: row.source_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    details: row.details,
  }));
  const ledger = evidenceRowsToLedger(rows, now);
  const result = evaluateEvidence(ledger, crowdEvidencePolicy(rules));
  const nowMs = Date.parse(now);
  const admissible = ledger.entries.filter((e) => Date.parse(e.at) <= nowMs);
  const originator = admissible.find((e) => e.kind === "report")?.reporterKey;
  const corroborations = new Set(
    admissible
      .filter((e) => e.kind === "confirm" || e.kind === "report")
      .map((e) => e.reporterKey)
      .filter((key) => key !== undefined && key !== originator),
  ).size;
  return { result, corroborations };
}

/**
 * Recomputes a crowd observation's evidence from its ledger, as
 * {@link recomputeEvidence} does a crowd situation's, into the columns of
 * the crowd row holding it (`evidence_state`, `confidence_score`,
 * `corroborations`) and its lifetime (`expires_at` and the record's
 * `freshness.expiresAt`, no revision: observations have none), then
 * recomputes the fused row its subject shows, since a report's evidence is
 * its fusion tier. The caller holds the crowd lock. `now` is the evaluation
 * instant, as for situations. Null when no crowd row
 * holds the observation any more (a later report of its series replaced
 * it) or it has no evidence.
 */
export async function recomputeObservationEvidence(
  tx: Tx,
  registry: Registry,
  observationId: string,
  now: string,
): Promise<EvidenceResult | null> {
  const [row] = await tx<
    { series_id: string; property: string; feature_id: string | null; instance_id: string }[]
  >`
    SELECT series_id::text AS series_id, property, feature_id,
           template #>> '{provenance,instanceId}' AS instance_id
      FROM conditions.observation_latest
     WHERE crowd_record_id = ${observationId} FOR UPDATE
  `;
  if (row === undefined) return null;
  const rules = crowdRulesFor(registry, { class: "observation", property: row.property });
  if (rules === undefined) return null;
  const evaluated = await evaluate(tx, "observation", observationId, rules, now);
  if (evaluated === null) return null;
  const { result, corroborations } = evaluated;
  await tx`
    UPDATE conditions.observation_latest SET
      evidence_state = ${result.state},
      confidence_score = ${result.confidenceScore},
      corroborations = ${corroborations},
      expires_at = ${result.expiresAt},
      reading = jsonb_set(reading, '{freshness,expiresAt}', to_jsonb(${result.expiresAt}::text))
    WHERE series_id = ${row.series_id}::bigint
  `;
  if (row.feature_id !== null) {
    // The fused row is this instance's, the one that landed the report.
    await refreshFused(tx, registry, [{ featureId: row.feature_id, properties: [row.property] }], {
      instanceId: row.instance_id,
      now,
    });
  }
  return { ...result, corroborations };
}
