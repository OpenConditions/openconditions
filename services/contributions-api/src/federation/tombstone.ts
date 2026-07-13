/**
 * Signed, reasoned tombstones. A deletion in OpenConditions is not a raw row
 * removal but a SOFT tombstone: the public row is scrubbed to a minimal deletion
 * record (`status = 'archived'` + text/attributes/subject/origin.reporter
 * cleared) while the `report_evidence` ledger is RETAINED for audit. The
 * federation outbox trigger (migration 0018) then emits a signed `delete`
 * tombstone carrying the row's `tombstone_reason`, so the retraction propagates
 * to every peer that might still hold the object.
 *
 * This is data MINIMISATION, not a legal-rights substitute: a short TTL reduces
 * exposure and tombstones are a best-effort technical measure, but they do not
 * discharge access/erasure obligations on their own (see docs/federation-gdpr.md).
 */
import type postgres from "postgres";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

/** Why a row became a tombstone; the DB `obs_tombstone_reason_enum` mirror. */
export type TombstoneReason =
  | "deleted_by_source"
  | "gdpr_erasure"
  | "retracted_as_wrong"
  | "expired"
  | "legal_takedown";

/** The tombstone reasons accepted on the wire / at the emit entry points. */
export const TOMBSTONE_REASONS: ReadonlySet<TombstoneReason> = new Set<TombstoneReason>([
  "deleted_by_source",
  "gdpr_erasure",
  "retracted_as_wrong",
  "expired",
  "legal_takedown",
]);

/** Whether `value` is one of the known {@link TombstoneReason}s. */
export function isTombstoneReason(value: unknown): value is TombstoneReason {
  return typeof value === "string" && TOMBSTONE_REASONS.has(value as TombstoneReason);
}

/** ADR §7.2 retention of the deletion FACT: a tombstone is terminal for this
 *  long (after which a re-discovered create may resurrect the record). */
export const TOMBSTONE_FACT_TTL_DAYS = 30;

/** Reasons that justify rewriting the append-only journal's historical PII —
 *  an erasure/takedown is precisely the case the append-only rule yields to. */
const ERASURE_REASONS: ReadonlySet<TombstoneReason> = new Set<TombstoneReason>([
  "gdpr_erasure",
  "legal_takedown",
]);

/**
 * Records (UPSERTs) the terminal deletion fact for a `canonicalId`: the tombstone
 * WINS over any later resupply/create of the same upstream record until
 * `expires_at` ({@link TOMBSTONE_FACT_TTL_DAYS} from `now`). The stored row is
 * the deletion fact only — never the erased content. A no-op when `canonicalId`
 * is absent (a non-federated / canonicalId-less row cannot be re-discovered by
 * canonicalId anyway).
 */
export async function recordTombstoneFact(
  tx: Tx,
  canonicalId: string | null | undefined,
  reason: TombstoneReason,
  now: string
): Promise<void> {
  if (!canonicalId) return;
  const expiresAt = new Date(Date.parse(now) + TOMBSTONE_FACT_TTL_DAYS * 24 * 60 * 60 * 1000);
  await tx`
    INSERT INTO conditions.federation_tombstone (canonical_id, reason, tombstoned_at, expires_at)
    VALUES (${canonicalId}, ${reason}, ${now}, ${expiresAt.toISOString()})
    ON CONFLICT (canonical_id) DO UPDATE SET
      reason = EXCLUDED.reason,
      tombstoned_at = EXCLUDED.tombstoned_at,
      expires_at = EXCLUDED.expires_at`;
}

/** Whether `canonicalId` has an ACTIVE (non-expired) terminal tombstone as of
 *  `now` — the gate the federated ingest consults before creating/rewriting. */
export async function hasActiveTombstone(
  tx: Tx,
  canonicalId: string | null | undefined,
  now: string
): Promise<boolean> {
  if (!canonicalId) return false;
  const rows = await tx<{ one: number }[]>`
    SELECT 1 AS one FROM conditions.federation_tombstone
    WHERE canonical_id = ${canonicalId} AND expires_at > ${now}
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * The GDPR-erasure-only exception to the append-only journal: an erasure /
 * takedown is the one case that justifies rewriting historical
 * `federation_outbox` snapshots, whose prior create/update `payload_snapshot`s
 * still carry the row's free text (headline/description/subject/attributes/label)
 * and would otherwise be served to peers replaying old cursors forever. Strips
 * exactly those keys from every non-delete snapshot of `objectId`, keeping
 * id/canonical_id/type/geometry and the delete tombstone entry intact. Reporter
 * identity is already absent (the capture trigger strips it). No effect for a
 * non-erasure reason.
 */
export async function scrubJournalResidue(
  tx: Tx,
  objectId: string,
  reason: TombstoneReason
): Promise<void> {
  if (!ERASURE_REASONS.has(reason)) return;
  await tx`
    UPDATE conditions.federation_outbox
    SET payload_snapshot = payload_snapshot
      - 'headline' - 'description' - 'subject' - 'attributes' - 'label'
    WHERE object_id = ${objectId} AND operation <> 'delete'`;
}

/**
 * SOFT-tombstones a single row IN the given transaction: sets `tombstone_reason`
 * (read by the outbox trigger), archives the row, and scrubs it to a minimal
 * deletion record — `headline/description/subject/label/severity/severity_level`
 * cleared, `attributes` replaced by the tombstone marker, and `origin.reporter`
 * dropped so no reporter identity survives on the public row (the ledger keeps
 * the linkage for audit). Geometry is NOT NULL and a road point/line is not
 * itself PII, so it is kept; `id/canonical_id/instance_id/
 * phenomenon_fingerprint` are kept for federation dedup + tombstone propagation.
 *
 * Guarded by `status <> 'archived'` so a re-apply is a no-op (no duplicate
 * outbox tombstone). Returns whether a row was actually tombstoned.
 */
export async function softTombstone(
  tx: Tx,
  observationId: string,
  reason: TombstoneReason,
  now: string
): Promise<boolean> {
  const marker = { tombstone: true, reason, at: now };
  const rows = await tx<{ id: string }[]>`
    UPDATE conditions.observations SET
      status = 'archived',
      tombstone_reason = ${reason},
      flagged_at = NULL,
      headline = NULL,
      description = NULL,
      subject = NULL,
      label = NULL,
      severity = NULL,
      severity_level = NULL,
      attributes = ${tx.json(marker)},
      origin = origin - 'reporter'
    WHERE id = ${observationId} AND status <> 'archived'
    RETURNING id`;
  return rows.length > 0;
}

/**
 * The operator/reviewer/GDPR entry point: soft-tombstone the observation with a
 * reason in ONE transaction holding `FOR UPDATE`, so the outbox trigger emits a
 * signed federation `delete` tombstone carrying that reason. Idempotent — a
 * missing or already-archived row is a no-op (`tombstoned: false`).
 */
export async function emitTombstone(
  sql: Sql,
  observationId: string,
  reason: TombstoneReason,
  now: string
): Promise<{ tombstoned: boolean }> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ status: string; canonical_id: string | null }[]>`
      SELECT status, canonical_id FROM conditions.observations
      WHERE id = ${observationId} FOR UPDATE`;
    if (row === undefined || row.status === "archived") {
      return { tombstoned: false };
    }
    const tombstoned = await softTombstone(tx, observationId, reason, now);
    // Record the terminal deletion fact (resurrection guard) and, for an
    // erasure/takedown, strip the historical journal PII.
    await recordTombstoneFact(tx, row.canonical_id, reason, now);
    await scrubJournalResidue(tx, observationId, reason);
    return { tombstoned };
  });
}
