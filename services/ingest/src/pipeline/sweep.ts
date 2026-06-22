import type postgres from "postgres";

type Sql = postgres.Sql;

export interface SweepOptions {
  /**
   * Rows whose `fetched_at` is older than this are treated as orphaned and
   * removed. Orphans accumulate when a source stops polling (ingest down for a
   * source, a feed disabled or persistently failing) so its per-source atomic
   * swap — the normal cleanup — never runs again. Must be comfortably larger
   * than the slowest feed cadence so a healthy slow source is never swept.
   */
  maxAgeSec: number;
}

export interface SweepResult {
  deleted: number;
}

/**
 * Deletes observations that should no longer be served or stored:
 *  - **expired** — `expires_at` or `valid_to` in the past;
 *  - **orphaned** — `fetched_at` older than {@link SweepOptions.maxAgeSec}.
 *
 * Complements the per-source atomic swap (which removes conditions that vanish
 * from a *still-polling* feed). A single row-level DELETE, safe to run
 * concurrently with swaps.
 */
export async function sweepStaleObservations(sql: Sql, opts: SweepOptions): Promise<SweepResult> {
  const deleted = await sql<{ id: string }[]>`
    DELETE FROM conditions.observations
    WHERE (expires_at IS NOT NULL AND expires_at < now())
       OR (valid_to   IS NOT NULL AND valid_to   < now())
       OR (fetched_at < now() - make_interval(secs => ${opts.maxAgeSec}))
    RETURNING id`;
  return { deleted: deleted.length };
}
