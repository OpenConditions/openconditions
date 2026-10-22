import type { Sql } from "./bulk.js";

/**
 * The least time between two liveness entries of one source. A peer holds a
 * reading for at least 30 minutes past the source's last arrival, so a
 * source that keeps polling arrives at least three times a window.
 */
export const SOURCE_LIVENESS_INTERVAL_SEC = 600;

/**
 * Journals that `sourceId` was just polled successfully, for the peers that
 * asked for it (a subscription with `sourceLiveness` that admits
 * observations). A change-only reading is journalled only when it changes,
 * so a peer holding a quiet source's readings learns from this entry that
 * they still hold. Written in the poll's transaction, after its changes, so
 * a peer never takes the source as polled before it has the poll's
 * readings. The entry states how often this instance polls the source, so a
 * peer holds the readings as long as this instance's polling keeps them
 * current. A restricted or on-demand source journals none, nor does a
 * source journalled less than {@link SOURCE_LIVENESS_INTERVAL_SEC} ago.
 * Returns whether an entry was written.
 */
export async function journalSourceLiveness(tx: Sql, sourceId: string): Promise<boolean> {
  const rows = await tx`
    INSERT INTO conditions.federation_outbox
      (operation, record_class, record_id, kind, domain, snapshot)
    SELECT 'liveness', 'observation', s.id, 'liveness', s.domain,
           jsonb_build_object('sourceId', s.id, 'polledAt', clock_timestamp(),
                              'cadenceSec', s.cadence_sec)
      FROM conditions.source s
     WHERE s.id = ${sourceId} AND NOT s.restricted AND s.access_mode = 'bulk'
       AND EXISTS (
         SELECT 1 FROM conditions.federation_subscription sub
          WHERE sub.filter @> '{"sourceLiveness": true}'
            AND (NOT (sub.filter ? 'classes') OR sub.filter -> 'classes' ? 'observation'))
       AND NOT EXISTS (
         SELECT 1 FROM conditions.federation_outbox o
          WHERE o.record_class = 'observation' AND o.record_id = s.id
            AND o.operation = 'liveness'
            AND o.created_at > now() - make_interval(secs => ${SOURCE_LIVENESS_INTERVAL_SEC}))
    RETURNING seq`;
  return rows.length > 0;
}
