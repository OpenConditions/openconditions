import type postgres from "postgres";
import { phenomenonFingerprintNeighborhood, type ConditionEvent } from "@openconditions/core";
import type { PhenomenonCandidate } from "@openconditions/contrib-core";
import { recomputeEvidence } from "./recompute.js";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

interface CandidateRow {
  id: string;
  domain: string;
  type: string | null;
  geojson: string;
  valid_from: Date | null;
  attributes: Record<string, unknown> | null;
  origin: { kind?: string; reporter?: { keyId?: string } } | null;
  source: string;
  status: string;
}

interface TargetRow {
  domain: string;
  type: string | null;
  kind: string;
  geojson: string;
  valid_from: Date | null;
}

function actorFor(row: CandidateRow): { keyId?: string; source: string } {
  if (row.origin?.kind === "crowd") {
    const keyId = row.origin.reporter?.keyId;
    return keyId !== undefined ? { keyId, source: row.source } : { source: row.source };
  }
  return { source: row.source };
}

/**
 * Find the active EVENT observations whose `phenomenon_fingerprint` falls in the
 * fingerprint NEIGHBORHOOD of `observationId` (the 3×3 grid cells × ±1 time
 * bucket, so cell-edge straddlers are still paired), excluding the observation
 * itself, projected into {@link PhenomenonCandidate}s. This only OPENS a typed
 * candidate set — {@link matchPhenomenonCandidates} decides compatibility and
 * nothing here merges.
 *
 * Returns an empty array when the observation does not exist, is not an event,
 * or has no `valid_from` (the neighborhood is time-bucketed).
 */
export async function findCandidates(
  sql: Sql,
  observationId: string
): Promise<PhenomenonCandidate[]> {
  const targetRows = await sql<TargetRow[]>`
    SELECT domain, type, kind, ST_AsGeoJSON(geom) AS geojson, valid_from
    FROM conditions.observations
    WHERE id = ${observationId}
  `;
  const target = targetRows[0];
  if (target === undefined || target.kind !== "event" || target.valid_from === null) {
    return [];
  }

  const evt: ConditionEvent = {
    kind: "event",
    domain: target.domain,
    type: target.type ?? "",
    geometry: JSON.parse(target.geojson),
    validFrom: target.valid_from.toISOString(),
  } as ConditionEvent;

  const neighborhood = phenomenonFingerprintNeighborhood(evt);

  const rows = await sql<CandidateRow[]>`
    SELECT id, domain, type, ST_AsGeoJSON(geom) AS geojson, valid_from,
           attributes, origin, source, status
    FROM conditions.observations
    WHERE kind = 'event'
      AND status = 'active'
      AND id <> ${observationId}
      AND phenomenon_fingerprint = ANY(${neighborhood})
  `;

  return rows.map((row) => ({
    id: row.id,
    domain: row.domain,
    type: row.type ?? "",
    geometry: JSON.parse(row.geojson),
    validFrom: row.valid_from === null ? undefined : row.valid_from.toISOString(),
    attributes: row.attributes ?? undefined,
    actor: actorFor(row),
    status: row.status,
  }));
}

interface LaterActorRow {
  origin: { kind?: string; reporter?: { keyId?: string } } | null;
  source: string;
  data_updated_at: Date;
}

interface CorroborationRow {
  id: string;
  status: string;
  valid_from: Date | null;
  data_updated_at: Date;
  origin: { kind?: string; reporter?: { keyId?: string } } | null;
  source: string;
}

/**
 * Stable global order over a corroboration pair: the EARLIER observation
 * (earliest `valid_from`, tiebreak smaller `id`) survives. A NULL `valid_from`
 * sorts last. Deterministic and independent of which row landed first, so two
 * concurrent landing hooks pick the SAME survivor regardless of execution order.
 */
function isEarlier(a: CorroborationRow, b: CorroborationRow): boolean {
  const av = a.valid_from === null ? Number.POSITIVE_INFINITY : a.valid_from.getTime();
  const bv = b.valid_from === null ? Number.POSITIVE_INFINITY : b.valid_from.getTime();
  if (av !== bv) return av < bv;
  return a.id < b.id;
}

async function lockObservationsInOrder(tx: Tx, ...ids: string[]): Promise<Set<string>> {
  // Deterministic lock order (sorted ids) so two corroborations touching the
  // same pair from opposite directions can never deadlock. Returns the ids that
  // actually exist (and are now locked) so callers can decide how to treat a
  // missing row.
  const locked = new Set<string>();
  for (const id of [...new Set(ids)].sort()) {
    const rows = await tx`SELECT id FROM conditions.observations WHERE id = ${id} FOR UPDATE`;
    if (rows.length > 0) {
      locked.add(id);
    }
  }
  return locked;
}

/**
 * Corroborate two independent reports of the same phenomenon. The argument order
 * does NOT matter: with both rows locked FOR UPDATE in a deterministic order,
 * this picks the survivor by a STABLE global rule ({@link isEarlier} — earlier
 * `valid_from`, tiebreak smaller `id`), so two concurrent landing hooks converge
 * on the SAME survivor regardless of who ran first.
 *
 * In ONE transaction:
 *  1. RE-READ both rows' status under the lock. If EITHER is already `inactive`
 *     (a row merged by a concurrent corroboration), SKIP entirely — this is what
 *     prevents cross-race annihilation (both hooks picking "self survives" and
 *     both marking the other inactive, so the real phenomenon vanishes).
 *  2. append a `confirm` evidence row on the SURVIVOR (actor = the merged
 *     report's reporter key and source; `occurred_at` = its `data_updated_at`),
 *     guarded so a repeat call appends nothing;
 *  3. union the merged id into the survivor's `corroborations` and `replaces`;
 *  4. mark the MERGED (later) observation `inactive`;
 *  5. recompute the survivor's evidence state in the SAME transaction.
 *
 * Idempotent: a concurrent double-call appends exactly one `confirm` row and one
 * `corroborations` entry. Corroboration never sets `routing_eligible` — only an
 * external resolution can.
 *
 * No geometry rewriting in v1; composing `start_unknown` + `end_unknown` extents
 * into a fused geometry is deliberately left as future work.
 *
 * @throws TypeError when the two ids are the same observation — self-corroboration
 *   is never valid evidence.
 * @throws Error when either observation row does not exist: a corroboration
 *   against a vanished row must fail loudly, not silently half-apply.
 */
export async function applyCorroboration(
  sql: Sql,
  observationIdA: string,
  observationIdB: string,
  now: string
): Promise<void> {
  if (observationIdA === observationIdB) {
    throw new TypeError("applyCorroboration: an observation cannot corroborate itself");
  }
  await sql.begin(async (tx) => {
    const locked = await lockObservationsInOrder(tx, observationIdA, observationIdB);
    for (const id of [observationIdA, observationIdB]) {
      if (!locked.has(id)) {
        throw new Error(`applyCorroboration: observation "${id}" does not exist`);
      }
    }

    const rows = await tx<CorroborationRow[]>`
      SELECT id, status, valid_from, data_updated_at, origin, source
      FROM conditions.observations
      WHERE id IN (${observationIdA}, ${observationIdB})
    `;
    const a = rows.find((r) => r.id === observationIdA)!;
    const b = rows.find((r) => r.id === observationIdB)!;

    // A row already merged elsewhere must not be re-merged: skipping here is what
    // makes concurrent hooks converge (one merges, the other no-ops) rather than
    // annihilate the phenomenon.
    if (a.status === "inactive" || b.status === "inactive") {
      return;
    }

    const [survivor, merged] = isEarlier(a, b) ? [a, b] : [b, a];
    const mergedKeyId = merged.origin?.reporter?.keyId ?? null;

    await tx`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
      SELECT ${survivor.id}, 'confirm', ${mergedKeyId}, ${merged.source},
             ${merged.data_updated_at}, ${tx.json({ via: "phenomenon-match", observationId: merged.id } as never)}
      WHERE NOT EXISTS (
        SELECT 1 FROM conditions.report_evidence
        WHERE observation_id = ${survivor.id}
          AND evidence_kind = 'confirm'
          AND details ->> 'observationId' = ${merged.id}
      )
    `;

    await unionInto(tx, survivor.id, merged.id);

    await tx`
      UPDATE conditions.observations SET status = 'inactive'
      WHERE id = ${merged.id}
    `;

    await recomputeEvidence(sql, survivor.id, now, tx);
  });
}

interface LineageRow {
  corroborations: string[] | null;
  replaces: string[] | null;
}

async function unionInto(tx: Tx, targetId: string, laterId: string): Promise<void> {
  const rows = await tx<LineageRow[]>`
    SELECT corroborations, replaces FROM conditions.observations WHERE id = ${targetId}
  `;
  const row = rows[0];
  if (row === undefined) {
    return;
  }
  const corroborations = [...new Set([...(row.corroborations ?? []), laterId])];
  const replaces = [...new Set([...(row.replaces ?? []), laterId])];
  await tx`
    UPDATE conditions.observations SET
      corroborations = ${tx.json(corroborations as never)},
      replaces = ${tx.json(replaces as never)}
    WHERE id = ${targetId}
  `;
}

/**
 * Apply a phenomenon-match negation: the `negationObservationId` (the standing
 * cancellation record, landed with status `cancelled` and `replaces=[targetId]`)
 * negates `targetObservationId`.
 *
 * In ONE transaction, with the target locked FOR UPDATE: append a `negate`
 * evidence row on the target carrying the negation report's actor (guarded so a
 * repeat call appends nothing), then recompute the target's evidence state in
 * the SAME transaction. The core evidence machinery decides the semantics from
 * the key — a negation from the ORIGINATING key retracts (immediate `negated`),
 * while a stranger's negation is peer evidence weighed against the peer-negation
 * quorum. The negation observation itself is left untouched; this function never
 * creates observations.
 *
 * @throws Error when either the negation or the target observation row does
 *   not exist: a negation against a vanished row must fail loudly, not
 *   silently half-apply.
 */
export async function applyNegation(
  sql: Sql,
  negationObservationId: string,
  targetObservationId: string,
  now: string
): Promise<void> {
  await sql.begin(async (tx) => {
    const locked = await lockObservationsInOrder(tx, targetObservationId);
    if (!locked.has(targetObservationId)) {
      throw new Error(`applyNegation: observation "${targetObservationId}" does not exist`);
    }

    const negationRows = await tx<LaterActorRow[]>`
      SELECT origin, source, data_updated_at
      FROM conditions.observations
      WHERE id = ${negationObservationId}
    `;
    const negation = negationRows[0];
    if (negation === undefined) {
      throw new Error(`applyNegation: observation "${negationObservationId}" does not exist`);
    }
    const negationKeyId = negation.origin?.reporter?.keyId ?? null;

    await tx`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
      SELECT ${targetObservationId}, 'negate', ${negationKeyId}, ${negation.source},
             ${negation.data_updated_at}, ${tx.json({ via: "phenomenon-match", observationId: negationObservationId } as never)}
      WHERE NOT EXISTS (
        SELECT 1 FROM conditions.report_evidence
        WHERE observation_id = ${targetObservationId}
          AND evidence_kind = 'negate'
          AND details ->> 'observationId' = ${negationObservationId}
      )
    `;

    await recomputeEvidence(sql, targetObservationId, now, tx);
  });
}
