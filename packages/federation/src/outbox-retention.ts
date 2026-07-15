/**
 * Retention / pruning for the federation outbox journal
 * (`conditions.federation_outbox`). The journal is append-only and grows
 * unbounded; this is the ONE place that trims it, on a SAFE, tier-bounded time
 * floor — never a subscriber cursor.
 *
 * WHY A TIME FLOOR, NOT A SLOWEST-SUBSCRIBER CURSOR. Live-serve is already
 * tier-time-bounded (the backfill windows in the federation service: Tier-0
 * 24h, Tier-1 30d, Tier-2 >= 30d), and pre-window history is designated to come
 * from the static GeoParquet archive, not the live journal. Crucially, PULL
 * peers keep their `after` cursor CLIENT-SIDE — the server tracks no per-pull-
 * peer acknowledged cursor (`federation_subscription.cursor` is the PUSH-channel
 * cursor only). So there is no "slowest subscriber ack" to prune against; the
 * only safe bound is a TIME FLOOR at least as wide as the widest live-serve
 * window, plus a safety margin so a peer mid-backfill at the window edge is
 * never cut off.
 *
 * THE FLOOR. `floorSec = max(retentionSec, DEFAULT_OUTBOX_RETENTION_SEC,
 * governanceWindowSec ?? 0)` — the effective minimum is the widest serve window
 * (Tier-1 30d) PLUS the safety margin, applied UNCONDITIONALLY (not only when
 * `retentionSec` is defaulted). The margin is load-bearing beyond "a peer
 * mid-backfill": the backfill archive-redirect
 * (`services/federation/src/backfill.ts` hasPreFloorEntries) detects "redirect
 * to the archive" by pre-floor rows still EXISTING, so pruning exactly at the
 * bare Tier-1 edge would delete the very rows that trigger the redirect and a
 * stale-cursor Tier-1 peer would then get a normal page with no
 * beyondWindow/archiveUrl — a silent gap. The margin keeps those rows alive.
 * An entry a Tier-1/2 peer could still legitimately pull live is NEVER pruned.
 * Rows with `created_at < now - floorSec` are deleted.
 *
 * THE ARCHIVE-COVERAGE GUARD (binding safety). Pre-window history is only safe
 * to drop once the static archive has durably captured it. When the operator
 * runs the archive job and passes its high-water mark (`archiveHighWaterIso`,
 * the newest `created_at` the archive has captured), the effective cutoff is
 * `min(now - floorSec, archiveHighWaterIso)` — nothing past the archive
 * high-water is ever pruned, even if older than the retention window. An
 * operator WITHOUT an archive omits it and simply keeps everything past the
 * window (the floor still protects the whole live-serve window).
 *
 * This module changes neither the outbox trigger, the composite `(txid, seq)`
 * cursor, nor the serve/backfill windows.
 */
import type postgres from "postgres";

/**
 * Prune cadence — daily, matching the registry-discovery cadence and well below
 * the retention window, so a missed run never risks over-pruning. The scheduling
 * itself (cron/interval) belongs to the federation service; this module is the
 * prune-and-report function it calls once per interval.
 */
export const OUTBOX_PRUNE_INTERVAL_HOURS = 24;

/**
 * The Tier-1 (peered) live-serve window in seconds — 30 days. The retention
 * floor can never dip below this: an entry a Tier-1/2 peer could still pull live
 * must never be pruned. Mirrors the federation service's
 * `BACKFILL_WINDOW_TIER_1_SEC`, the widest non-governance serve window; kept
 * here because this package is the lower layer and cannot depend on the service.
 */
export const OUTBOX_RETENTION_TIER1_FLOOR_SEC = 2_592_000;

/**
 * Safety margin added on top of the widest serve window for the DEFAULT
 * retention (7 days), so a peer mid-backfill at the very edge of the window is
 * never cut off between the serve boundary and the prune cutoff.
 */
export const OUTBOX_RETENTION_SAFETY_MARGIN_SEC = 604_800;

/**
 * Default retention when no `retentionSec` is given: the widest serve window
 * (Tier-1, 30 days) plus the safety margin (7 days) = 37 days.
 */
export const DEFAULT_OUTBOX_RETENTION_SEC =
  OUTBOX_RETENTION_TIER1_FLOOR_SEC + OUTBOX_RETENTION_SAFETY_MARGIN_SEC;

/**
 * Rows deleted per statement. The delete runs in bounded chunks rather than one
 * statement so the FIRST prune of a journal that grew large (e.g. the daily cron
 * was down for a long stretch) never runs as a single long-lived,
 * lock-holding transaction over millions of rows — each chunk commits before the
 * next, releasing locks between batches. Steady-state daily prunes delete far
 * fewer than one batch and complete in a single round-trip.
 */
export const DEFAULT_OUTBOX_PRUNE_BATCH_SIZE = 10_000;

export interface PruneOutboxOptions {
  /**
   * Requested retention in seconds. Clamped UP to the Tier-1 floor PLUS the
   * safety margin ({@link DEFAULT_OUTBOX_RETENTION_SEC}, applied unconditionally)
   * and to any governance window; defaults to the same value. A non-finite value
   * falls back to the default.
   */
  retentionSec?: number;
  /** The evaluation instant (ISO 8601). */
  now: string;
  /**
   * A Tier-2 governance retention window in seconds. When it exceeds the Tier-1
   * floor and the requested retention, it widens the floor (a governance anchor
   * keeps at least as much history as it serves). A non-finite value is ignored.
   */
  governanceWindowSec?: number;
  /**
   * The newest `created_at` (ISO 8601) the static archive has DURABLY captured.
   * When provided, nothing newer than this instant is pruned even if it is older
   * than the retention floor — the effective cutoff is
   * `min(now - floorSec, archiveHighWaterIso)`. Omit it when no archive exists
   * (then everything past the floor is simply kept).
   */
  archiveHighWaterIso?: string;
  /**
   * Max rows deleted per statement (default {@link DEFAULT_OUTBOX_PRUNE_BATCH_SIZE}).
   * A non-finite or non-positive value falls back to the default. Pass `sql` as a
   * pool (not a transaction) so each batch commits between iterations.
   */
  batchSize?: number;
}

export interface PruneOutboxResult {
  /** Number of journal rows deleted. */
  deleted: number;
  /** The computed retention floor (`now - floorSec`) as an ISO 8601 instant. */
  floorIso: string;
}

/** The requested retention clamped up to the Tier-1 floor PLUS the safety margin
 *  (applied unconditionally, so the archive redirect's pre-floor rows always
 *  survive) and any governance window; a non-finite requested value falls back
 *  to the default. */
function resolveFloorSec(retentionSec: number | undefined, governanceWindowSec: number): number {
  const requested =
    retentionSec !== undefined && Number.isFinite(retentionSec)
      ? retentionSec
      : DEFAULT_OUTBOX_RETENTION_SEC;
  const governance = Number.isFinite(governanceWindowSec) ? governanceWindowSec : 0;
  return Math.max(requested, DEFAULT_OUTBOX_RETENTION_SEC, governance);
}

/**
 * Prunes journal rows older than the tier-time floor, honouring the
 * archive-coverage guard. Idempotent — a second run at the same `now` deletes
 * nothing. Returns the number deleted and the computed floor (the retention
 * boundary, not the archive-adjusted effective cutoff).
 */
export async function pruneOutbox(
  sql: postgres.Sql,
  opts: PruneOutboxOptions
): Promise<PruneOutboxResult> {
  const floorSec = resolveFloorSec(opts.retentionSec, opts.governanceWindowSec ?? 0);
  const nowMs = Date.parse(opts.now);
  const floorMs = nowMs - floorSec * 1000;
  const floorIso = new Date(floorMs).toISOString();

  // Archive-coverage guard: never prune past what the archive durably captured.
  // The effective cutoff is the EARLIER of the retention floor and the archive
  // high-water, so a pre-window row the archive has not yet captured survives.
  //
  // Fail CLOSED on a provided-but-unparseable high-water: an empty string (the
  // classic Compose `${VAR:-}` interpolation) or garbage must NOT silently skip
  // the guard and delete un-archived rows the operator asked to protect — throw.
  let cutoffIso = floorIso;
  if (opts.archiveHighWaterIso !== undefined) {
    const archiveMs = Date.parse(opts.archiveHighWaterIso);
    if (!Number.isFinite(archiveMs)) {
      throw new TypeError(
        `pruneOutbox: archiveHighWaterIso must be a valid ISO 8601 instant, got ` +
          `"${opts.archiveHighWaterIso}"`
      );
    }
    if (archiveMs < floorMs) {
      // Normalize to a Z-suffixed UTC instant before it reaches Postgres, so the
      // ::timestamptz coercion reads it in UTC (a TZ-naive ISO would be
      // server-local to Postgres but UTC to Date.parse) — consistent with the
      // now-floor path, which already goes through toISOString().
      cutoffIso = new Date(archiveMs).toISOString();
    }
  }

  const batchSize =
    opts.batchSize !== undefined && Number.isFinite(opts.batchSize) && opts.batchSize > 0
      ? Math.floor(opts.batchSize)
      : DEFAULT_OUTBOX_PRUNE_BATCH_SIZE;

  // Delete in bounded chunks (oldest first, via the created_at index) so a large
  // backlog never locks the journal in one long transaction. Each statement is
  // its own autocommit round-trip when `sql` is a pool, so locks release between
  // batches. The WHERE predicate is identical to a single delete — only the
  // execution is chunked — so the "never prune a servable/un-archived row"
  // guarantee is unchanged. A partial batch means no rows remain: stop.
  let deleted = 0;
  for (;;) {
    const result = await sql`
      DELETE FROM conditions.federation_outbox
      WHERE seq IN (
        SELECT seq FROM conditions.federation_outbox
        WHERE created_at < ${cutoffIso}::timestamptz
        ORDER BY created_at
        LIMIT ${batchSize}
      )`;
    deleted += result.count;
    if (result.count < batchSize) break;
  }

  return { deleted, floorIso };
}
