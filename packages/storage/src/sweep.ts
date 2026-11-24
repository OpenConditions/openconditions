import type { RevisionedClass } from "@openconditions/core/server";
import type { Registry } from "@openconditions/model";
import type postgres from "postgres";
import { updateCanonicalView } from "./canonical-view.js";
import { isLockTimeout } from "./db-timeouts.js";
import { PEER_LAPSED, PEER_LIVENESS_LAPSE_SEC, recordLapsedCopies } from "./federation-lapse.js";
import { refreshFused } from "./fused-rows.js";
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
  /**
   * A longer max age per source: a feed whose snapshot is fetched once a day
   * keeps its records while that snapshot holds, however its faster roles fare.
   */
  sourceMaxAgeSec?: Readonly<Record<string, number>>;
  /** How long a tombstoned record and its revisions are kept for the history API (see `pruneRevisions` for a live one's). */
  historyDays: number;
  /**
   * How long a peer that sends liveness may stay silent about a source before
   * its copies of the source end (default {@link PEER_LIVENESS_LAPSE_SEC}).
   */
  peerLapseSec?: number;
}

export interface SweepCounts {
  /** Records tombstoned because their own expiry passed. */
  expired: number;
  /** Feed records tombstoned because their source stopped polling. */
  orphaned: number;
  /** Peers' copies tombstoned because the peer fell silent about their source. */
  lapsed: number;
  /** Tombstoned records purged, with their revisions. */
  purged: number;
  /** On-demand rows (records and series) deleted at expiry. */
  dropped: number;
  /** Crowd readings whose report's lifetime ended, marked expired. */
  crowdExpired: number;
  /** Series of transient properties deleted once their reading expired. */
  transient: number;
  /** Crowd reporters deleted after {@link REPORTER_RETENTION_MONTHS} without activity. */
  reporters: number;
  /** Token quota rows of an epoch that has ended. */
  tokenQuotas: number;
  /** Spent-token rows a day past the token's own expiry. */
  spentTokens: number;
  /** Federation erasure facts past their retention. */
  federationTombstones: number;
  /**
   * Passes over a source, or retention batches, left to the next sweep: a
   * lock was held past `lock_timeout`.
   */
  busy: number;
}

/**
 * How long a crowd reporter is kept once both its last enrollment and its
 * entitlement lie behind it: a reporter that has not enrolled for this long
 * is deleted, and enrolling again starts a new reporter.
 */
export const REPORTER_RETENTION_MONTHS = 12;

/**
 * Rows one retention delete takes. Each batch is its own statement and
 * transaction, so a sweep holds its row locks only for one batch, and a
 * reporter's cascade touches its own votes, refusals, quotas and evidence.
 */
const RETENTION_BATCH = 500;

/** How long a spent token is kept past its expiry, for clocks that disagree. */
const SPENT_TOKEN_MARGIN = "1 day";

const CLASSES: readonly RevisionedClass[] = ["situation", "feature", "offer"];

/** A live, bulk record whose own expiry has passed. ($1 = now) */
const EXPIRED = `r.tombstoned_at IS NULL AND r.access_mode = 'bulk' AND r.expires_at < $1`;

/**
 * A live record of this instance's feeds whose source has had no successful
 * poll for the max age and is not polling now: a national register's first
 * publish may run past the max age, and its source is not gone while it does.
 * ($1 = now, $2 = instance id, $3 = max age in seconds, $4 = max age by
 * source, a JSON object)
 */
const ORPHANED = `r.tombstoned_at IS NULL AND r.instance_id = $2 AND r.origin IN ('feed', 'derived')
  AND NOT EXISTS (
    SELECT 1 FROM conditions.source_status ss
     WHERE ss.source = r.source_id
       AND ss.last_success_at >= $1::timestamptz - make_interval(
             secs => COALESCE(($4::text::jsonb ->> r.source_id)::int, $3)))
  AND NOT EXISTS (
    SELECT 1 FROM conditions.source_poll_attempt pa
     WHERE pa.source = r.source_id AND pa.outcome = 'running')`;

/**
 * Ends what should no longer be served, without losing its history:
 *  - a record whose `freshness.expiresAt` has passed is tombstoned `expired`
 *    (a crowd report's lifetime, a feed's own expiry);
 *  - a feed record of this instance whose source has had no successful poll
 *    for `maxAgeSec` (its own `sourceMaxAgeSec` when longer), and is not
 *    polling now, is tombstoned `expired` — a still-polling source ends
 *    its records itself, by leaving them out of its snapshot;
 *  - a peer's copy without an expiry, of a peer that sends liveness of its
 *    source but has been silent about it past the lapse window, is
 *    tombstoned `expired` at the peer's revision and noted, so the peer's
 *    returning liveness brings it back ({@link restoreLapsedCopies});
 *  - a record tombstoned more than `historyDays` ago is purged with its
 *    revisions, effects, components, bindings, crowd evidence and votes;
 *  - an on-demand row is deleted at expiry: it was a cache, with no history;
 *  - a series of a transient property (one reading of one instant, such as
 *    a fire pixel) is deleted once its reading expired, bulk or on demand:
 *    nothing else would ever end it. Its history row stays until its
 *    partition is dropped;
 *  - a crowd reading whose report's lifetime ended is marked `expired`, and
 *    the fused rows it fed are recomputed without it. Its series row stays:
 *    it is what the reading's history is read back through;
 *  - crowd and federation bookkeeping past its retention is deleted (see
 *    {@link sweepRetention}): inactive reporters with what they left,
 *    token quotas of ended epochs, spent tokens past their expiry and
 *    expired erasure facts.
 * A feature that ends or goes leaves the canonical view with it. A declared validity end is never a reason: a source that still publishes
 * an ended record keeps it, and reads filter by time. Every tombstone and
 * delete of a record is chosen and written under its source's advisory lock,
 * like any other write, so a poll or a confirmation in between is never
 * undone; the crowd and federation bookkeeping uses row locks instead (see
 * {@link sweepRetention}).
 */
export async function sweepRecords(sql: postgres.Sql, opts: SweepOptions): Promise<SweepCounts> {
  const counts: SweepCounts = {
    expired: 0,
    orphaned: 0,
    lapsed: 0,
    purged: 0,
    dropped: 0,
    crowdExpired: 0,
    transient: 0,
    reporters: 0,
    tokenQuotas: 0,
    spentTokens: 0,
    federationTombstones: 0,
    busy: 0,
  };
  const busy = () => counts.busy++;
  const params = [
    opts.now,
    opts.instanceId,
    opts.maxAgeSec,
    JSON.stringify(opts.sourceMaxAgeSec ?? {}),
  ];
  const relink = (tx: postgres.TransactionSql, sourceId: string, featureIds: string[]) =>
    updateCanonicalView(tx, opts.registry, { sourceId, featureIds, observations: [] }, opts);
  const tombstone =
    (cls: RevisionedClass) =>
    async (tx: postgres.TransactionSql, ids: string[], sourceId: string) => {
      await tombstoneRecords(tx, cls, ids, "expired", opts);
      if (cls === "feature") await relink(tx, sourceId, ids);
    };
  const remove =
    (table: string, key: string, type = "text") =>
    (tx: postgres.TransactionSql, ids: string[]) =>
      tx.unsafe(`DELETE FROM conditions.${table} WHERE ${key} = ANY($1::${type}[])`, [ids]);
  // A record's graph bindings, crowd evidence and votes have no foreign key
  // to it: they go with it.
  const removeRecords =
    (cls: RevisionedClass) => async (tx: postgres.TransactionSql, ids: string[]) => {
      for (const table of [
        "record_segment",
        "record_binding",
        "binding_queue",
        "report_evidence",
        "federation_lapsed_copy",
      ]) {
        await tx.unsafe(
          `DELETE FROM conditions.${table} WHERE record_class = $1 AND record_id = ANY($2::text[])`,
          [cls, ids],
        );
      }
      await tx.unsafe(
        `DELETE FROM conditions.sub_claim WHERE subject_class = $1 AND subject_id = ANY($2::text[])`,
        [cls, ids],
      );
      await remove(cls, "id")(tx, ids);
    };
  const dropOnDemand =
    (cls: RevisionedClass) =>
    async (tx: postgres.TransactionSql, ids: string[], sourceId: string) => {
      await removeRecords(cls)(tx, ids);
      if (cls === "feature") await relink(tx, sourceId, ids);
    };
  for (const cls of CLASSES) {
    const rows = { table: cls, key: "id" };
    counts.dropped += await perSource(
      sql,
      busy,
      rows,
      ON_DEMAND_EXPIRED,
      [opts.now],
      dropOnDemand(cls),
    );
    counts.expired += await perSource(sql, busy, rows, EXPIRED, [opts.now], tombstone(cls));
    counts.orphaned += await perSource(sql, busy, rows, ORPHANED, params, tombstone(cls));
    counts.lapsed += await perSource(
      sql,
      busy,
      rows,
      PEER_LAPSED,
      [opts.now, opts.instanceId, opts.peerLapseSec ?? PEER_LIVENESS_LAPSE_SEC],
      async (tx, ids, sourceId) => {
        await tombstone(cls)(tx, ids, sourceId);
        await recordLapsedCopies(tx, cls, ids, opts.now);
      },
    );
    counts.purged += await perSource(
      sql,
      busy,
      rows,
      PURGEABLE,
      [opts.now, opts.historyDays],
      removeRecords(cls),
    );
  }
  counts.dropped += await perSource(
    sql,
    busy,
    { table: "observation_latest", key: "series_id" },
    ON_DEMAND_EXPIRED,
    [opts.now],
    remove("observation_latest", "series_id", "bigint"),
  );
  const transient = opts.registry
    .properties()
    .filter((p) => p.transient)
    .map((p) => p.code);
  if (transient.length > 0) {
    counts.transient = await perSource(
      sql,
      busy,
      { table: "observation_latest", key: "series_id" },
      TRANSIENT_EXPIRED,
      [opts.now, transient],
      remove("observation_latest", "series_id", "bigint"),
      TRANSIENT_BATCH,
    );
  }
  try {
    counts.crowdExpired = await expireCrowdObservations(sql, opts);
  } catch (err) {
    if (!isLockTimeout(err)) throw err;
    busy();
  }
  Object.assign(counts, await sweepRetention(sql, opts.now, busy));
  return counts;
}

/**
 * Deletes crowd and federation bookkeeping past its retention:
 *  - a reporter whose `last_active_at` and `entitlement_expires_at` both lie
 *    more than {@link REPORTER_RETENTION_MONTHS} before `now`. Both columns
 *    are NOT NULL, so neither stands for "unknown"; the delete strips the
 *    reporter's key from what it reported (its trigger), takes its votes,
 *    refusals and token quotas with it and clears its key from the evidence
 *    it gave (the foreign keys' actions). Its block-list entry stays, so the
 *    key enrolls blocked again;
 *  - a token quota row whose epoch, a UTC day, has ended. An epoch of
 *    another form is left alone; it goes with its reporter;
 *  - a spent-token row a day past `expires_at`, its token's own expiry: the
 *    day covers a contributions service whose clock runs behind this one,
 *    which would still redeem the token until its own clock passes the
 *    expiry;
 *  - a federation erasure fact past `expires_at`.
 * Each runs in batches of {@link RETENTION_BATCH} rows, skipping rows another
 * transaction holds (the next sweep takes them); a batch that meets a lock
 * held past `lock_timeout` is left to the next sweep and counted by `busy`.
 */
async function sweepRetention(
  sql: postgres.Sql,
  now: string,
  busy: () => void,
): Promise<
  Pick<SweepCounts, "reporters" | "tokenQuotas" | "spentTokens" | "federationTombstones">
> {
  const federationTombstones = await deleteInBatches(
    sql,
    busy,
    "federation_tombstone",
    ["canonical_id", "peer_instance_id"],
    `expires_at < $1`,
    [now],
  );
  const spentTokens = await deleteInBatches(
    sql,
    busy,
    "spent_token",
    ["token_hash"],
    `expires_at < $1::timestamptz - interval '${SPENT_TOKEN_MARGIN}'`,
    [now],
  );
  const tokenQuotas = await deleteInBatches(
    sql,
    busy,
    "token_quota",
    ["key_id", "epoch"],
    `epoch ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND epoch COLLATE "C" < to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    [now],
  );
  const reporters = await deleteInactiveReporters(sql, busy, now);
  return { reporters, tokenQuotas, spentTokens, federationTombstones };
}

/**
 * Deletes the reporters inactive past {@link REPORTER_RETENTION_MONTHS},
 * {@link RETENTION_BATCH} per transaction. Each takes the crowd's lock first,
 * then the reporter rows it can lock without waiting, then deletes them: the
 * order every landing takes them in (the crowd's lock, then the reporter row
 * its evidence references), so the two never deadlock, and a landing holding
 * the lock is never interleaved with the delete. The delete's trigger strips
 * the reporters' keys from what they reported, and its foreign keys take
 * their votes, refusals and quotas.
 */
async function deleteInactiveReporters(
  sql: postgres.Sql,
  busy: () => void,
  now: string,
): Promise<number> {
  let n = 0;
  for (;;) {
    let taken: number;
    try {
      taken = (await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('crowd'))`;
        const keys = (
          await tx<{ key_id: string }[]>`
            SELECT key_id FROM conditions.reporter
             WHERE last_active_at < ${now}::timestamptz
                     - make_interval(months => ${REPORTER_RETENTION_MONTHS})
               AND entitlement_expires_at < ${now}::timestamptz
                     - make_interval(months => ${REPORTER_RETENTION_MONTHS})
             LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED`
        ).map((r) => r.key_id);
        if (keys.length === 0) return 0;
        return (await tx`DELETE FROM conditions.reporter WHERE key_id = ANY(${keys})`).count;
      })) as number;
    } catch (err) {
      if (!isLockTimeout(err)) throw err;
      busy();
      break;
    }
    n += taken;
    if (taken < RETENTION_BATCH) return n;
  }
  return n;
}

/**
 * Deletes the rows of `table` matching `where`, {@link RETENTION_BATCH} per
 * statement, until a batch comes back short. Rows locked by another
 * transaction are skipped rather than waited for. Returns how many it deleted.
 */
async function deleteInBatches(
  sql: postgres.Sql,
  busy: () => void,
  table: string,
  key: readonly string[],
  where: string,
  params: readonly (string | number)[],
): Promise<number> {
  const cols = key.join(", ");
  let n = 0;
  for (;;) {
    let taken: number;
    try {
      const rows = await sql.unsafe(
        `DELETE FROM conditions.${table} WHERE (${cols}) IN (
           SELECT ${cols} FROM conditions.${table} WHERE ${where}
            LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED)
         RETURNING 1`,
        [...params],
      );
      taken = rows.length;
    } catch (err) {
      if (!isLockTimeout(err)) throw err;
      busy();
      break;
    }
    n += taken;
    if (taken < RETENTION_BATCH) return n;
  }
  return n;
}

/**
 * Marks the crowd readings whose report's lifetime has passed `expired`,
 * under the crowd's lock, and recomputes the fused rows they fed. A negated
 * report stays negated: that is the stronger statement.
 */
async function expireCrowdObservations(sql: postgres.Sql, opts: SweepOptions): Promise<number> {
  return (await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('crowd'))`;
    const rows = await tx<{ feature_id: string | null; property: string }[]>`
      UPDATE conditions.observation_latest SET evidence_state = 'expired'
       WHERE source_id = 'crowd' AND expires_at < ${opts.now}
         AND evidence_state IS DISTINCT FROM 'expired' AND evidence_state IS DISTINCT FROM 'negated'
      RETURNING feature_id, property`;
    await refreshFused(
      tx,
      opts.registry,
      rows.flatMap((r) =>
        r.feature_id === null ? [] : [{ featureId: r.feature_id, properties: [r.property] }],
      ),
      opts,
    );
    return rows.length;
  })) as number;
}

/** An on-demand row past its expiry. ($1 = now) */
const ON_DEMAND_EXPIRED = `r.access_mode = 'on_demand' AND r.expires_at < $1`;

/** A series of a transient property past its reading's expiry. ($1 = now, $2 = the properties) */
const TRANSIENT_EXPIRED = `r.property = ANY($2::text[]) AND r.expires_at < $1`;

/**
 * Transient series deleted per transaction: a day of satellite detections
 * is hundreds of thousands of rows, and one source's lock is held only for
 * a batch at a time, so a poll of that source waits for no more than that.
 */
const TRANSIENT_BATCH = 5000;

/** A record tombstoned longer ago than the history window. ($1 = now, $2 = history days) */
const PURGEABLE = `r.tombstoned_at < $1::timestamptz - make_interval(days => $2)`;

/**
 * Runs `act` on the rows of `table` matching `where`, one transaction per
 * source under its advisory lock, on the rows that still match once the lock
 * is held — so a poll writing in between is never undone. With `batch`, a
 * source's rows are taken at most that many per transaction, until none is
 * left. A source whose lock is held past `lock_timeout` (a long publication)
 * is left to the next sweep and counted by `busy`. Returns how many rows it
 * acted on.
 */
async function perSource(
  sql: postgres.Sql,
  busy: () => void,
  { table, key }: { table: string; key: string },
  where: string,
  params: readonly (string | number | readonly string[])[],
  act: (tx: postgres.TransactionSql, ids: string[], sourceId: string) => Promise<unknown>,
  batch?: number,
): Promise<number> {
  const sources = await sql.unsafe<{ source_id: string }[]>(
    `SELECT DISTINCT r.source_id FROM conditions.${table} r WHERE ${where}`,
    [...params],
  );
  const limit = batch === undefined ? "" : `LIMIT ${batch}`;
  let n = 0;
  for (const { source_id } of sources) {
    let taken: number;
    do {
      try {
        taken = (await sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${source_id}))`;
          const rows = await tx.unsafe<{ id: string }[]>(
            `SELECT r.${key} AS id FROM conditions.${table} r
              WHERE ${where} AND r.source_id = $${params.length + 1} ${limit}`,
            [...params, source_id],
          );
          if (rows.length === 0) return 0;
          await act(
            tx,
            rows.map((r) => String(r.id)),
            source_id,
          );
          return rows.length;
        })) as number;
      } catch (err) {
        if (!isLockTimeout(err)) throw err;
        busy();
        break;
      }
      n += taken;
    } while (batch !== undefined && taken === batch);
  }
  return n;
}
