import type { RevisionedClass } from "@openconditions/core/server";
import type { Registry } from "@openconditions/model";
import type postgres from "postgres";
import { tombstoneRecords } from "./write-records.js";

export interface SweepOptions {
  registry: Registry;
  /** This instance's id: only its own feed records depend on its polling. */
  instanceId: string;
  now: string;
  /**
   * A feed record is expired once its source has had no successful poll for
   * this long. Must comfortably exceed the slowest feed's cadence.
   */
  maxAgeSec: number;
  /** How long a tombstoned record and its revisions are kept for the history API. */
  historyDays: number;
}

export interface SweepCounts {
  /** Records tombstoned because their own expiry passed. */
  expired: number;
  /** Feed records tombstoned because their source stopped polling. */
  orphaned: number;
  /** Tombstoned records purged, with their revisions. */
  purged: number;
  /** On-demand rows (records and series) deleted at expiry. */
  dropped: number;
}

const CLASSES: readonly RevisionedClass[] = ["situation", "feature", "offer"];

/** A live, bulk record whose own expiry has passed. ($1 = now) */
const EXPIRED = `r.tombstoned_at IS NULL AND r.access_mode = 'bulk' AND r.expires_at < $1`;

/**
 * A live record of this instance's feeds whose source has had no successful
 * poll for the max age. ($1 = now, $2 = instance id, $3 = max age in seconds)
 */
const ORPHANED = `r.tombstoned_at IS NULL AND r.instance_id = $2 AND r.origin IN ('feed', 'derived')
  AND NOT EXISTS (
    SELECT 1 FROM conditions.source_status ss
     WHERE ss.source = r.source_id
       AND ss.last_success_at >= $1::timestamptz - make_interval(secs => $3))`;

/**
 * Ends what should no longer be served, without losing its history:
 *  - a record whose `freshness.expiresAt` has passed is tombstoned `expired`
 *    (a crowd report's lifetime, a feed's own expiry);
 *  - a feed record of this instance whose source has had no successful poll
 *    for `maxAgeSec` is tombstoned `expired` — a still-polling source ends
 *    its records itself, by leaving them out of its snapshot;
 *  - a record tombstoned more than `historyDays` ago is purged with its
 *    revisions, effects and components;
 *  - an on-demand row is deleted at expiry: it was a cache, with no history.
 * A declared validity end is never a reason: a source that still publishes
 * an ended record keeps it, and reads filter by time. Tombstones are chosen
 * and written under their source's advisory lock, like any other write, so a
 * poll or a confirmation in between is never undone.
 */
export async function sweepRecords(sql: postgres.Sql, opts: SweepOptions): Promise<SweepCounts> {
  const counts: SweepCounts = { expired: 0, orphaned: 0, purged: 0, dropped: 0 };
  const params = [opts.now, opts.instanceId, opts.maxAgeSec];
  for (const cls of CLASSES) {
    const dropped = await sql.unsafe(
      `DELETE FROM conditions.${cls}
        WHERE access_mode = 'on_demand' AND expires_at < $1 RETURNING id`,
      [opts.now],
    );
    counts.dropped += dropped.length;
    counts.expired += await tombstoneWhere(sql, cls, EXPIRED, [opts.now], opts);
    counts.orphaned += await tombstoneWhere(sql, cls, ORPHANED, params, opts);
    const purged = await sql.unsafe(
      `DELETE FROM conditions.${cls}
        WHERE tombstoned_at < $1::timestamptz - make_interval(days => $2) RETURNING id`,
      [opts.now, opts.historyDays],
    );
    counts.purged += purged.length;
  }
  const series = await sql`
    DELETE FROM conditions.observation_latest
     WHERE access_mode = 'on_demand' AND expires_at < ${opts.now} RETURNING series_id`;
  counts.dropped += series.length;
  return counts;
}

/** Tombstones `expired` every record matching `where`, one transaction per source under its lock. */
async function tombstoneWhere(
  sql: postgres.Sql,
  cls: RevisionedClass,
  where: string,
  params: readonly (string | number)[],
  opts: SweepOptions,
): Promise<number> {
  const sources = await sql.unsafe<{ source_id: string }[]>(
    `SELECT DISTINCT r.source_id FROM conditions.${cls} r WHERE ${where}`,
    [...params],
  );
  let n = 0;
  for (const { source_id } of sources) {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${source_id}))`;
      const ids = await tx.unsafe<{ id: string }[]>(
        `SELECT r.id FROM conditions.${cls} r WHERE ${where} AND r.source_id = $${params.length + 1}`,
        [...params, source_id],
      );
      await tombstoneRecords(
        tx,
        cls,
        ids.map((r) => r.id),
        "expired",
        opts,
      );
      n += ids.length;
    });
  }
  return n;
}
