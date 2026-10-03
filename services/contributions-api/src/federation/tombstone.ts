/**
 * Erasure facts. When a record is tombstoned because the rights to it were
 * revoked (`rights_revoked`, the erasure reason), its canonical id is
 * recorded in `conditions.federation_tombstone` for
 * {@link TOMBSTONE_FACT_TTL_DAYS} days, and no delivery of that canonical id
 * is admitted meanwhile — from any peer when this instance erased it, from
 * the erasing peer when a peer did — an erased record must not come back
 * through a late page, a backfill or another path. Every other tombstone
 * needs no fact: a peer's record is fenced by its revision, and a later
 * revision from its own instance legitimately restores it. The ROW is the
 * deletion fact — never the erased content.
 *
 * {@link eraseRecord} is the operator's erasure (a GDPR request, a takedown):
 * the record is tombstoned `rights_revoked`, which journals a delete for the
 * peers and removes its earlier outbox entries, and its fact is recorded.
 */

import { type RevisionedClass, resolveInstanceId } from "@openconditions/core/server";
import type { Registry } from "@openconditions/model";
import { tombstoneRecords, updateCanonicalView } from "@openconditions/storage";
import type postgres from "postgres";

type Sql = postgres.Sql | postgres.TransactionSql;

/**
 * A feature that ended outside a source's poll (an erasure, a peer's
 * retraction) leaves the canonical feature it was linked into, as a
 * withdrawn one does: its cluster is recomputed without it and the fused
 * rows it fed follow, so its readings and location stop showing there.
 */
export async function leaveCanonicalView(
  tx: postgres.TransactionSql,
  registry: Registry,
  ref: { class: string; id: string },
  sourceId: string,
  ctx: { instanceId: string; now: string },
): Promise<void> {
  if (ref.class !== "feature") return;
  await updateCanonicalView(
    tx,
    registry,
    { sourceId, featureIds: [ref.id], observations: [] },
    ctx,
  );
}

/** Serializes work on one record across the inbox and erasure: a delivery against a retraction. */
export async function lockRecord(
  tx: postgres.TransactionSql,
  cls: string,
  id: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`federation:${cls}:${id}`}, 0))`;
}

/**
 * Erases a record held here: tombstones it `rights_revoked` under its source's
 * lock (a new revision; the content stays in its history until the history
 * window purges it) and records the erasure fact. Erasing an erased record
 * changes nothing.
 */
export async function eraseRecord(
  sql: postgres.Sql,
  registry: Registry,
  ref: { class: RevisionedClass; id: string },
  now: string,
  instanceId: string = resolveInstanceId(),
): Promise<"erased" | "already erased" | "not found"> {
  return sql.begin(async (tx) => {
    await lockRecord(tx, ref.class, ref.id);
    const [row] = await tx.unsafe<
      { source_id: string; canonical_id: string; tombstone_reason: string | null }[]
    >(
      `SELECT source_id, canonical_id, tombstone_reason FROM conditions.${ref.class} WHERE id = $1`,
      [ref.id],
    );
    if (row === undefined) return "not found";
    if (row.tombstone_reason === ERASURE_REASON) return "already erased";
    await tx`SELECT pg_advisory_xact_lock(hashtext(${row.source_id}))`;
    await tombstoneRecords(tx, ref.class, [ref.id], ERASURE_REASON, { registry, now });
    await leaveCanonicalView(tx, registry, ref, row.source_id, { instanceId, now });
    await recordErasure(tx, row.canonical_id, now);
    return "erased";
  }) as Promise<"erased" | "already erased" | "not found">;
}

/** How long an erasure fact refuses the erased record. */
export const TOMBSTONE_FACT_TTL_DAYS = 30;

/** The tombstone reason that erases: the rights to the record were revoked. */
export const ERASURE_REASON = "rights_revoked";

/**
 * Records the erasure fact of a canonical id (a no-op without one): this
 * instance's own without `peer`, which refuses the record from every peer, or
 * a peer's, which refuses only that peer's deliveries.
 */
export async function recordErasure(
  db: Sql,
  canonicalId: string | null | undefined,
  now: string,
  peer = "",
): Promise<void> {
  if (!canonicalId) return;
  const expiresAt = new Date(Date.parse(now) + TOMBSTONE_FACT_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db`
    INSERT INTO conditions.federation_tombstone
      (canonical_id, peer_instance_id, reason, tombstoned_at, expires_at)
    VALUES (${canonicalId}, ${peer}, ${ERASURE_REASON}, ${now}, ${expiresAt.toISOString()})
    ON CONFLICT (canonical_id, peer_instance_id) DO UPDATE SET
      tombstoned_at = GREATEST(federation_tombstone.tombstoned_at, EXCLUDED.tombstoned_at),
      expires_at = GREATEST(federation_tombstone.expires_at, EXCLUDED.expires_at)`;
}

/**
 * Whether a canonical id was erased within the fact's lifetime, by this
 * instance or by `peer`.
 */
export async function isErased(
  db: Sql,
  canonicalId: string | null | undefined,
  now: string,
  peer = "",
): Promise<boolean> {
  if (!canonicalId) return false;
  const rows = await db<{ one: number }[]>`
    SELECT 1 AS one FROM conditions.federation_tombstone
    WHERE canonical_id = ${canonicalId} AND peer_instance_id IN ('', ${peer})
      AND expires_at > ${now}
    LIMIT 1`;
  return rows.length > 0;
}
