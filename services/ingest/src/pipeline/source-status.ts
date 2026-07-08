import type postgres from "postgres";

// Accepts either the top-level pool or an open transaction, so `atomicSwap`
// can call this from inside its own `sql.begin()` to make the success status
// write atomic with the swap it belongs to (see write-postgis.ts).
type Sql = postgres.Sql | postgres.TransactionSql;

export type SourceStatusOutcome = "success" | "error";

export interface SourceStatusUpdate {
  /** Threaded through on every attempt so a feed's own poll cadence is what
   * the read-path freshness join compares against, even on an error cycle. */
  freshnessWindowSec: number;
  outcome: SourceStatusOutcome;
  /** Row count for the source this cycle. Only applied on success; when
   * omitted (e.g. a 304/unchanged poll that didn't recompute a count) the
   * prior value is kept rather than reset to null. */
  rowCount?: number;
  /** Error message for an error outcome. Ignored on success (last_error is
   * always cleared there, mirroring FeedStatusStore's "success clears error"
   * behavior). */
  error?: string;
}

/**
 * Upserts `conditions.source_status` on EVERY poll — including a successful
 * no-op (a 304 on every URL, or a fetch gated by `fetchIntervalSec`) — so
 * freshness/orphan-status can be derived from *when the source last actually
 * succeeded*, not from any individual row's `fetched_at`. Before this, a
 * healthy feed sitting behind a 304 never touched its rows' `fetched_at` and
 * so aged out of {@link import("./sweep.js").sweepStaleObservations} after
 * `ORPHAN_MAX_AGE_SEC` even though it was still perfectly healthy.
 *
 * Two separate statements (rather than one with conditional SQL) so the
 * success/error semantics stay simple to read: success always advances
 * `last_success_at` + clears `last_error`; error always sets `last_error` and
 * never touches `last_success_at`/`last_row_count` (an error must not erase
 * "this source last worked at X").
 */
export async function upsertSourceStatus(
  sql: Sql,
  sourceId: string,
  update: SourceStatusUpdate
): Promise<void> {
  if (update.outcome === "success") {
    await sql`
      INSERT INTO conditions.source_status (
        source, last_attempt_at, last_success_at, freshness_window_sec, last_row_count, last_error, updated_at
      )
      VALUES (
        ${sourceId}, now(), now(), ${update.freshnessWindowSec}, ${update.rowCount ?? null}, NULL, now()
      )
      ON CONFLICT (source) DO UPDATE SET
        last_attempt_at = now(),
        last_success_at = now(),
        freshness_window_sec = excluded.freshness_window_sec,
        last_row_count = COALESCE(excluded.last_row_count, conditions.source_status.last_row_count),
        last_error = NULL,
        updated_at = now()
    `;
    return;
  }

  await sql`
    INSERT INTO conditions.source_status (
      source, last_attempt_at, last_success_at, freshness_window_sec, last_row_count, last_error, updated_at
    )
    VALUES (
      ${sourceId}, now(), NULL, ${update.freshnessWindowSec}, NULL, ${update.error ?? null}, now()
    )
    ON CONFLICT (source) DO UPDATE SET
      last_attempt_at = now(),
      freshness_window_sec = excluded.freshness_window_sec,
      last_error = excluded.last_error,
      updated_at = now()
  `;
}
