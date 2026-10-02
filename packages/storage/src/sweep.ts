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
 * an ended record keeps it, and reads filter by time. Every tombstone and
 * delete is chosen and written under its source's advisory lock, like any
 * other write, so a poll or a confirmation in between is never undone.
 */
export async function sweepRecords(sql: postgres.Sql, opts: SweepOptions): Promise<SweepCounts> {
  const counts: SweepCounts = { expired: 0, orphaned: 0, purged: 0, dropped: 0 };
  const params = [opts.now, opts.instanceId, opts.maxAgeSec];
  const tombstone = (cls: RevisionedClass) => (tx: postgres.TransactionSql, ids: string[]) =>
    tombstoneRecords(tx, cls, ids, "expired", opts);
  const remove =
    (table: string, key: string, type = "text") =>
    (tx: postgres.TransactionSql, ids: string[]) =>
      tx.unsafe(`DELETE FROM conditions.${table} WHERE ${key} = ANY($1::${type}[])`, [ids]);
  // A record's graph bindings have no foreign key to it: they go with it.
  const removeRecords =
    (cls: RevisionedClass) => async (tx: postgres.TransactionSql, ids: string[]) => {
      for (const table of ["record_segment", "record_binding", "binding_queue"]) {
        await tx.unsafe(
          `DELETE FROM conditions.${table} WHERE record_class = $1 AND record_id = ANY($2::text[])`,
          [cls, ids],
        );
      }
      await remove(cls, "id")(tx, ids);
    };
  for (const cls of CLASSES) {
    const rows = { table: cls, key: "id" };
    counts.dropped += await perSource(sql, rows, ON_DEMAND_EXPIRED, [opts.now], removeRecords(cls));
    counts.expired += await perSource(sql, rows, EXPIRED, [opts.now], tombstone(cls));
    counts.orphaned += await perSource(sql, rows, ORPHANED, params, tombstone(cls));
    counts.purged += await perSource(
      sql,
      rows,
      PURGEABLE,
      [opts.now, opts.historyDays],
      removeRecords(cls),
    );
  }
  counts.dropped += await perSource(
    sql,
    { table: "observation_latest", key: "series_id" },
    ON_DEMAND_EXPIRED,
    [opts.now],
    remove("observation_latest", "series_id", "bigint"),
  );
  return counts;
}

/** An on-demand row past its expiry. ($1 = now) */
const ON_DEMAND_EXPIRED = `r.access_mode = 'on_demand' AND r.expires_at < $1`;

/** A record tombstoned longer ago than the history window. ($1 = now, $2 = history days) */
const PURGEABLE = `r.tombstoned_at < $1::timestamptz - make_interval(days => $2)`;

/**
 * Runs `act` on the rows of `table` matching `where`, one transaction per
 * source under its advisory lock, on the rows that still match once the lock
 * is held — so a poll writing in between is never undone. Returns how many
 * rows it acted on.
 */
async function perSource(
  sql: postgres.Sql,
  { table, key }: { table: string; key: string },
  where: string,
  params: readonly (string | number)[],
  act: (tx: postgres.TransactionSql, ids: string[]) => Promise<unknown>,
): Promise<number> {
  const sources = await sql.unsafe<{ source_id: string }[]>(
    `SELECT DISTINCT r.source_id FROM conditions.${table} r WHERE ${where}`,
    [...params],
  );
  let n = 0;
  for (const { source_id } of sources) {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${source_id}))`;
      const rows = await tx.unsafe<{ id: string }[]>(
        `SELECT r.${key} AS id FROM conditions.${table} r
          WHERE ${where} AND r.source_id = $${params.length + 1}`,
        [...params, source_id],
      );
      if (rows.length === 0) return;
      await act(
        tx,
        rows.map((r) => String(r.id)),
      );
      n += rows.length;
    });
  }
  return n;
}
