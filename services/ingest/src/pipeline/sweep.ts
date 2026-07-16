import type postgres from "postgres";

type Sql = postgres.Sql;

export interface SweepOptions {
  /**
   * A source is treated as orphaned (and every one of its rows removed) when
   * its `conditions.source_status.last_success_at` is older than this, or it
   * has no `source_status` row at all (stopped polling entirely, or never
   * registered a single successful cycle). Orphans accumulate when a source
   * stops polling (ingest down for a source, a feed disabled or persistently
   * failing) so its per-source atomic swap — the normal cleanup — never runs
   * again. Must be comfortably larger than the slowest feed cadence so a
   * healthy slow source is never swept.
   */
  maxAgeSec: number;
}

export interface SweepResult {
  deleted: number;
}

/**
 * Deletes observations that should no longer be served or stored:
 *  - **expired** — `expires_at` or `valid_to` in the past (ALL origins);
 *  - **orphaned** — a *feed* row whose *source* has no recent success in
 *    `conditions.source_status` (see {@link SweepOptions.maxAgeSec}).
 *
 * Orphan status is derived per-SOURCE from `source_status`, not per-row from
 * `fetched_at`: the diff-upsert swap only refreshes `fetched_at` for rows that
 * actually changed, so an unchanged-but-healthy row's `fetched_at` can be
 * arbitrarily old even though its source is still polling successfully (e.g.
 * every poll coming back 304). Deriving orphan status from `fetched_at`
 * per-row would eventually sweep every last-good row of a perfectly healthy
 * feed.
 *
 * The orphan sweep is scoped to `origin.kind = 'feed'`. Crowd reports (and any
 * other non-feed origin — e.g. federated crowd) have no polling `source_status`
 * row at all, so an unscoped orphan check would delete every crowd report on the
 * next cycle regardless of its `expires_at`. Crowd rows carry their own
 * evidence-derived `expires_at`/`valid_to` (set by the contributions-api
 * recompute), so the per-row expiry above is their sole sweep trigger.
 *
 * A deleted observation's `report_evidence` rows are removed in the same
 * transaction so an expired crowd report never leaves orphaned evidence behind.
 *
 * Complements the per-source atomic swap (which removes conditions that vanish
 * from a *still-polling* feed). Safe to run concurrently with swaps.
 */
export async function sweepStaleObservations(sql: Sql, opts: SweepOptions): Promise<SweepResult> {
  return sql.begin(async (tx) => {
    const deleted = await tx<{ id: string }[]>`
      DELETE FROM conditions.observations o
      WHERE (o.expires_at IS NOT NULL AND o.expires_at < now())
         OR (o.valid_to   IS NOT NULL AND o.valid_to   < now())
         OR (
           o.origin->>'kind' = 'feed'
           AND NOT EXISTS (
             SELECT 1 FROM conditions.source_status ss
             WHERE ss.source = o.source
               AND ss.last_success_at IS NOT NULL
               AND ss.last_success_at >= now() - make_interval(secs => ${opts.maxAgeSec})
           )
         )
      RETURNING o.id`;
    if (deleted.length > 0) {
      await tx`
        DELETE FROM conditions.report_evidence
        WHERE observation_id = ANY(${deleted.map((r) => r.id)})`;
    }
    return { deleted: deleted.length };
  }) as Promise<SweepResult>;
}
