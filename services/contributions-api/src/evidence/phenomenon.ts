import type postgres from "postgres";
import { phenomenonFingerprintNeighborhood, type ConditionEvent } from "@openconditions/core";
import type { PhenomenonCandidate } from "@openconditions/contrib-core";
import { recomputeEvidence } from "./recompute.js";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

/** Cluster-lineage walk bound: deep merges are rare, a runaway walk is a bug. */
const MAX_SURVIVOR_HOPS = 16;

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

function actorFor(row: CandidateRow): { kind: "crowd" | "feed"; keyId?: string; source: string } {
  if (row.origin?.kind === "feed") {
    return { kind: "feed", source: row.source };
  }
  // Crowd (and any non-feed/absent origin.kind default here): carry a reporter
  // keyId only when present. A federated crowd row is keyId-less but still
  // kind 'crowd'. An unexpected/absent kind is unreachable on real data —
  // normalize.ts rejects any origin.kind outside {crowd, feed} on every write
  // path — so this default only defends against a malformed direct DB write; it
  // maps to keyId-less crowd, which is the conservative shape (it still enforces
  // same-reporter-key for a keyed row). The end-to-end safety against a malformed
  // row self-corroborating/routing rests on the caller gates (autoCorroborate's
  // keyed-crowd-only candidate filter, crossValidate's local-feed-only SQL), NOT
  // on this matcher default alone.
  const keyId = row.origin?.reporter?.keyId;
  return keyId !== undefined
    ? { kind: "crowd", keyId, source: row.source }
    : { kind: "crowd", source: row.source };
}

export interface FindCandidatesOptions {
  /**
   * Also return `status='inactive'` neighborhood rows (merged survivors of an
   * earlier corroboration). `status='archived'` tombstones — reviewer-rejected
   * or GDPR-erased — are ALWAYS excluded and must never become a corroboration
   * target. Off by default: the direct-match path only ever pairs active rows.
   */
  includeInactive?: boolean;
}

/**
 * Find the EVENT observations whose `phenomenon_fingerprint` falls in the
 * fingerprint NEIGHBORHOOD of `observationId` (the 3×3 grid cells × ±1 time
 * bucket, so cell-edge straddlers are still paired), excluding the observation
 * itself, projected into {@link PhenomenonCandidate}s. This only OPENS a typed
 * candidate set — {@link matchPhenomenonCandidates} decides compatibility and
 * nothing here merges. Only `active` rows are returned unless
 * {@link FindCandidatesOptions.includeInactive} is set; `archived` tombstones
 * are never returned.
 *
 * Returns an empty array when the observation does not exist, is not an event,
 * or has no `valid_from` (the neighborhood is time-bucketed).
 */
export async function findCandidates(
  sql: Sql,
  observationId: string,
  opts: FindCandidatesOptions = {}
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

  // `includeInactive` widens the set to merged (`inactive`) rows so a fresh
  // report can be redirected to their active survivor. Both modes enumerate live
  // states explicitly (never `archived` tombstones, never `cancelled` records) —
  // stating intent rather than excluding one known bad state.
  const statusFilter = opts.includeInactive
    ? sql`status IN ('active', 'inactive')`
    : sql`status = 'active'`;

  const rows = await sql<CandidateRow[]>`
    SELECT id, domain, type, ST_AsGeoJSON(geom) AS geojson, valid_from,
           attributes, origin, source, status
    FROM conditions.observations
    WHERE kind = 'event'
      AND ${statusFilter}
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

/**
 * Project the given observation ids into {@link PhenomenonCandidate}s (same shape
 * {@link findCandidates} emits), regardless of their fingerprint neighborhood.
 * Used to re-read a resolved SURVIVOR — which may sit outside the just-landed
 * row's neighborhood — so the pure matcher can decide compatibility against it.
 * Returns only the ids that exist as events.
 */
export async function loadPhenomenonCandidates(
  sql: Sql,
  ids: string[]
): Promise<PhenomenonCandidate[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows = await sql<CandidateRow[]>`
    SELECT id, domain, type, ST_AsGeoJSON(geom) AS geojson, valid_from,
           attributes, origin, source, status
    FROM conditions.observations
    WHERE kind = 'event' AND id = ANY(${ids})
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

interface SurvivorRow {
  id: string;
  status: string;
}

/**
 * Resolve an observation to the ACTIVE survivor of its corroboration cluster.
 *
 * - An `active` row is its own survivor.
 * - An `inactive` (merged) row is followed UP the CORROBORATION lineage: the
 *   head is the row whose `corroborations` array contains the current id. Only
 *   `corroborations` is followed — `replaces` is a different relation (feed
 *   supersession, federation versioning, and cancellation records write it) and
 *   is NOT corroboration lineage; applyCorroboration always records the merged id
 *   in `corroborations`, so the corroboration chain is fully captured there. The
 *   lookup is deterministic (`ORDER BY valid_from, id`) and scoped to event rows
 *   in a live state, so it never resolves onto a cancellation/tombstone record.
 *   This walks multi-level merges (B→A→Z) to the earliest active head.
 * - Returns `null` when the chain dead-ends without an active head — a missing
 *   row, an `archived` tombstone (GDPR/reviewer-rejected — never a target), or
 *   a cluster with no surviving active row.
 *
 * Bounded to {@link MAX_SURVIVOR_HOPS} hops with a visited-set cycle guard, so a
 * self-referential or looping lineage returns `null` instead of hanging. Pure
 * function of the ledger (no clock, no randomness); pass a transaction handle to
 * resolve inside a larger unit of work.
 */
export async function resolveSurvivor(
  sql: Sql,
  observationId: string,
  tx?: Tx
): Promise<string | null> {
  const runner = tx ?? sql;
  const visited = new Set<string>();
  let currentId = observationId;

  for (let hop = 0; hop < MAX_SURVIVOR_HOPS; hop++) {
    if (visited.has(currentId)) {
      return null;
    }
    visited.add(currentId);

    const rows = await runner<SurvivorRow[]>`
      SELECT id, status FROM conditions.observations WHERE id = ${currentId}
    `;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    if (row.status === "active") {
      return currentId;
    }
    if (row.status !== "inactive") {
      // An archived tombstone (or any non-active, non-inactive state) is never a
      // survivor and never a corroboration target.
      return null;
    }

    const parents = await runner<{ id: string }[]>`
      SELECT id FROM conditions.observations
      WHERE corroborations @> ${runner.json([currentId] as never)}::jsonb
        AND kind = 'event'
        AND status IN ('active', 'inactive')
      ORDER BY valid_from, id
      LIMIT 1
    `;
    const parent = parents[0];
    if (parent === undefined) {
      return null;
    }
    currentId = parent.id;
  }

  return null;
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
 *  3. MIGRATE the merged row's existing `confirm` rows onto the survivor, so
 *     every distinct witness the merged row had accrued keeps crediting the head
 *     when composition flips it (a just-landed EARLIER report becoming the head
 *     must not strand the confirms an inactive later head already held). Same
 *     NOT-EXISTS guard, keyed by `details.observationId`, so no confirmer is
 *     double-counted;
 *  4. union the merged id into the survivor's `corroborations` and `replaces`;
 *  5. mark the MERGED (later) observation `inactive`;
 *  6. recompute the survivor's evidence state in the SAME transaction.
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

    // Re-parent the merged row's OWN confirms onto the head. Without this, a
    // just-landed report that is EARLIER than the resolved survivor flips the
    // head under isEarlier and would strand the prior witnesses' confirms on the
    // now-inactive row, so the new head would show fewer distinct confirmers than
    // the cluster actually has. Keyed by details.observationId so each distinct
    // confirmer is credited to the head exactly once.
    await tx`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
      SELECT ${survivor.id}, 'confirm', m.actor_key_id, m.source_id, m.occurred_at, m.details
      FROM conditions.report_evidence m
      WHERE m.observation_id = ${merged.id}
        AND m.evidence_kind = 'confirm'
        AND NOT EXISTS (
          SELECT 1 FROM conditions.report_evidence s
          WHERE s.observation_id = ${survivor.id}
            AND s.evidence_kind = 'confirm'
            AND s.details ->> 'observationId' = m.details ->> 'observationId'
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
