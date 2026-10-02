import type { Registry } from "@openconditions/model";
import { tombstoneRecords } from "@openconditions/storage";
import type postgres from "postgres";
import { actorOf, lockCrowd, type StoredSituation } from "../crowd.js";
import { recomputeEvidence } from "./recompute.js";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

/** Lineage walk bound: deep merges are rare, a runaway walk is a bug. */
const MAX_SURVIVOR_HOPS = 16;

/**
 * Resolve crowd situations to the LIVE survivor of their corroboration
 * cluster.
 *
 * - A live situation is its own survivor.
 * - A superseded one (merged into another) is followed up its lineage: the
 *   survivor's ledger holds a confirm naming it in `details.merged`. A merged
 *   report's own confirms are carried to its survivor, so the live head of a
 *   chain names every report merged into it; the walk prefers a live parent
 *   and otherwise takes the earliest, so multi-level merges (B→A→Z) end at
 *   the earliest live head.
 * - `null` when the chain ends without a live head — a missing row, a record
 *   tombstoned for another reason (rejected, expired), or a cluster with no
 *   live situation left.
 *
 * Bounded to {@link MAX_SURVIVOR_HOPS} hops with a visited-set cycle guard.
 */
export async function resolveSurvivors(
  db: Sql | Tx,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const paths = new Map([...new Set(ids)].map((id) => [id, { current: id, visited: new Set() }]));
  for (let hop = 0; hop < MAX_SURVIVOR_HOPS && paths.size > 0; hop++) {
    const currents = [...new Set([...paths.values()].map((path) => path.current))];
    const rows = await db<
      {
        id: string;
        tombstone_reason: string | null;
        tombstoned: boolean;
        parent_id: string | null;
      }[]
    >`
      SELECT s.id, s.tombstone_reason, s.tombstoned_at IS NOT NULL AS tombstoned,
             parent.id AS parent_id
      FROM conditions.situation s
      LEFT JOIN LATERAL (
        SELECT p.id FROM conditions.report_evidence e
        JOIN conditions.situation p ON p.id = e.record_id
        WHERE s.tombstone_reason = 'superseded'
          AND e.record_class = 'situation' AND e.evidence_kind = 'confirm'
          AND e.details ->> 'merged' = s.id AND e.record_id <> s.id
          AND (p.tombstoned_at IS NULL OR p.tombstone_reason = 'superseded')
        ORDER BY p.tombstoned_at IS NOT NULL, p.valid_from, p.id
        LIMIT 1
      ) parent ON true
      WHERE s.id = ANY(${currents})`;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [root, path] of paths) {
      const row = byId.get(path.current);
      if (row === undefined || path.visited.has(path.current)) {
        result.set(root, null);
        paths.delete(root);
      } else if (!row.tombstoned) {
        result.set(root, row.id);
        paths.delete(root);
      } else if (row.tombstone_reason !== "superseded" || row.parent_id === null) {
        result.set(root, null);
        paths.delete(root);
      } else {
        path.visited.add(path.current);
        path.current = row.parent_id;
      }
    }
  }
  for (const root of paths.keys()) result.set(root, null);
  return result;
}

/**
 * Stable global order over a corroboration pair: the EARLIER report survives
 * (earliest `validity.start`, tiebreak smaller id), so two concurrent landing
 * hooks pick the SAME survivor whichever ran first.
 */
function isEarlier(a: StoredSituation, b: StoredSituation): boolean {
  const start = (s: StoredSituation) => {
    const at = (s.record["validity"] as { start?: string } | undefined)?.start;
    return at === undefined ? Number.POSITIVE_INFINITY : Date.parse(at);
  };
  if (start(a) !== start(b)) return start(a) < start(b);
  return a.id < b.id;
}

async function lockInOrder(tx: Tx, ids: readonly string[]): Promise<Map<string, StoredSituation>> {
  // Deterministic lock order (sorted ids) so two corroborations touching the
  // same pair from opposite directions can never deadlock.
  const locked = new Map<string, StoredSituation>();
  for (const id of [...new Set(ids)].sort()) {
    const [row] = await tx<
      {
        id: string;
        kind: string;
        type: string;
        record: Record<string, unknown>;
        tombstone_reason: string | null;
        flagged_at: Date | null;
      }[]
    >`SELECT id, kind, type, record, tombstone_reason, flagged_at
      FROM conditions.situation WHERE id = ${id} FOR UPDATE`;
    if (row !== undefined) {
      locked.set(id, {
        id: row.id,
        kind: row.kind,
        type: row.type,
        record: row.record,
        evidenceState: null,
        routingEligible: false,
        flaggedAt: row.flagged_at,
        tombstoneReason: row.tombstone_reason,
      });
    }
  }
  return locked;
}

/**
 * Corroborate two independent crowd reports of the same phenomenon. The
 * argument order does NOT matter: with both rows locked in a deterministic
 * order, the survivor is picked by a STABLE global rule ({@link isEarlier}).
 *
 * In ONE transaction under the crowd lock:
 *  1. RE-READ both rows under the lock. If EITHER is already tombstoned (a
 *     report merged by a concurrent corroboration), SKIP entirely — this is
 *     what prevents both hooks picking "self survives" and both superseding
 *     the other, so the real phenomenon vanishes.
 *  2. append a `confirm` evidence row on the SURVIVOR (actor = the merged
 *     report's reporter key and source, at the merged report's landing time,
 *     `details.merged` = its id), guarded so a repeat call appends nothing;
 *  3. carry the merged report's own `confirm` rows to the survivor, so every
 *     distinct witness it accrued keeps crediting the head when a just-landed
 *     EARLIER report becomes the head;
 *  4. tombstone the merged (later) report `superseded`;
 *  5. recompute the survivor's evidence in the SAME transaction.
 *
 * Corroboration never makes a report routing-eligible — only an external
 * resolution can.
 *
 * @throws TypeError when the two ids are the same situation.
 * @throws Error when either situation does not exist.
 */
export async function applyCorroboration(
  sql: Sql,
  registry: Registry,
  idA: string,
  idB: string,
  now: string,
): Promise<void> {
  if (idA === idB) {
    throw new TypeError("applyCorroboration: a report cannot corroborate itself");
  }
  await sql.begin(async (tx) => {
    await lockCrowd(tx);
    const locked = await lockInOrder(tx, [idA, idB]);
    const a = locked.get(idA);
    const b = locked.get(idB);
    if (a === undefined || b === undefined) {
      throw new Error(
        `applyCorroboration: situation "${a === undefined ? idA : idB}" does not exist`,
      );
    }
    if (a.tombstoneReason !== null || b.tombstoneReason !== null) return;

    const [survivor, merged] = isEarlier(a, b) ? [a, b] : [b, a];
    const actor = actorOf(merged.record);
    const landedAt = (merged.record["freshness"] as { fetchedAt: string }).fetchedAt;

    await tx`
      INSERT INTO conditions.report_evidence
        (record_class, record_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
      SELECT 'situation', ${survivor.id}, 'confirm', ${actor.keyId ?? null}, ${actor.sourceId},
             ${landedAt}, ${tx.json({ via: "phenomenon-match", merged: merged.id })}
      WHERE NOT EXISTS (
        SELECT 1 FROM conditions.report_evidence
        WHERE record_class = 'situation' AND record_id = ${survivor.id}
          AND evidence_kind = 'confirm' AND details ->> 'merged' = ${merged.id}
      )
    `;
    await tx`
      INSERT INTO conditions.report_evidence
        (record_class, record_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
      SELECT 'situation', ${survivor.id}, 'confirm', m.actor_key_id, m.source_id, m.occurred_at,
             m.details
      FROM conditions.report_evidence m
      WHERE m.record_class = 'situation' AND m.record_id = ${merged.id}
        AND m.evidence_kind = 'confirm'
        AND NOT EXISTS (
          SELECT 1 FROM conditions.report_evidence s
          WHERE s.record_class = 'situation' AND s.record_id = ${survivor.id}
            AND s.evidence_kind = 'confirm'
            AND s.actor_key_id IS NOT DISTINCT FROM m.actor_key_id
            AND s.details = m.details
        )
    `;
    await tombstoneRecords(tx, "situation", [merged.id], "superseded", { registry, now });
    await recomputeEvidence(sql, registry, survivor.id, now, tx);
  });
}
