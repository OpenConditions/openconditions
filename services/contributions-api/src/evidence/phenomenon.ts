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
 * Apply a phenomenon-match corroboration: the `laterObservationId` (a second,
 * independent report of the same phenomenon) confirms `targetObservationId`.
 *
 * In ONE transaction, with both observation rows locked FOR UPDATE in a
 * deterministic order:
 *  1. append a `confirm` evidence row on the target (actor = the later report's
 *     reporter key and source; `occurred_at` = the later report's
 *     `data_updated_at`), guarded so a repeat call appends nothing;
 *  2. union `laterObservationId` into the target's `corroborations` and `replaces`;
 *  3. mark the later observation `inactive` (the target is the survivor);
 *  4. recompute the target's evidence state in the SAME transaction.
 *
 * Idempotent: a concurrent double-call appends exactly one `confirm` row and one
 * `corroborations` entry. Corroboration never sets `routing_eligible` — only an
 * external resolution can.
 *
 * No geometry rewriting in v1; composing `start_unknown` + `end_unknown` extents
 * into a fused geometry is deliberately left as future work.
 *
 * @throws TypeError when `laterObservationId` and `targetObservationId` are the
 *   same observation — self-corroboration is never valid evidence.
 * @throws Error when either observation row does not exist: a corroboration
 *   against a vanished row must fail loudly, not silently half-apply.
 */
export async function applyCorroboration(
  sql: Sql,
  laterObservationId: string,
  targetObservationId: string,
  now: string
): Promise<void> {
  if (laterObservationId === targetObservationId) {
    throw new TypeError("applyCorroboration: an observation cannot corroborate itself");
  }
  await sql.begin(async (tx) => {
    const locked = await lockObservationsInOrder(tx, targetObservationId, laterObservationId);
    for (const id of [targetObservationId, laterObservationId]) {
      if (!locked.has(id)) {
        throw new Error(`applyCorroboration: observation "${id}" does not exist`);
      }
    }

    const laterRows = await tx<LaterActorRow[]>`
      SELECT origin, source, data_updated_at
      FROM conditions.observations
      WHERE id = ${laterObservationId}
    `;
    const later = laterRows[0]!;
    const laterKeyId = later.origin?.reporter?.keyId ?? null;

    await tx`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
      SELECT ${targetObservationId}, 'confirm', ${laterKeyId}, ${later.source},
             ${later.data_updated_at}, ${tx.json({ via: "phenomenon-match", observationId: laterObservationId } as never)}
      WHERE NOT EXISTS (
        SELECT 1 FROM conditions.report_evidence
        WHERE observation_id = ${targetObservationId}
          AND evidence_kind = 'confirm'
          AND details ->> 'observationId' = ${laterObservationId}
      )
    `;

    await unionInto(tx, targetObservationId, laterObservationId);

    await tx`
      UPDATE conditions.observations SET status = 'inactive'
      WHERE id = ${laterObservationId}
    `;

    await recomputeEvidence(sql, targetObservationId, now, tx);
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
