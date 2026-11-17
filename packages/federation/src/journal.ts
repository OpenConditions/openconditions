/**
 * The journal's epoch and how far its fence lags.
 *
 * A journal cursor is `(txid, seq)` with `txid` a raw Postgres transaction id,
 * so it only means something within one database history. The epoch
 * (`conditions.federation_journal`, one row) names that history, and every
 * page states it.
 *
 * - After a logical restore transaction ids start low again: the stored
 *   `seen_xid` and the journal's own entries are ahead of the counter, and
 *   every cursor a subscriber holds names a transaction that has not happened
 *   yet in this history.
 * - A young database restored from a dump may already be past the stored
 *   ids, since the restore itself uses transaction ids. Restored into any
 *   database, its OID differs from the stored one; a database re-created
 *   from a template does too, and a move to another cluster changes the
 *   cluster's system identifier. Either names another database.
 * - After point-in-time recovery or a promotion the Postgres timeline
 *   changes, and transactions the subscribers saw may be gone.
 * - After rolling the database back in place from a filesystem snapshot or an
 *   older base backup nothing in the database says so (its OID and the
 *   cluster's identifier stay); the operator deletes the row before starting
 *   the service.
 *
 * In each case {@link ensureJournalEpoch} starts a new epoch at boot: the
 * journal is emptied of everything but its delete entries (entries of two
 * histories cannot be ordered against each other, so the deletes are carried
 * over under one new transaction id), every push cursor goes back to the
 * start, and the journal seed that runs next journals the current records
 * again for the subscriptions that exist. A subscriber that sees the new epoch
 * reads the journal again from the start: the retractions it may have missed,
 * then what is live, landing what it already holds as stale.
 *
 * The fence (`txid < pg_snapshot_xmin(pg_current_snapshot())`, see
 * outbox.ts) holds back every committed entry while an older write
 * transaction is open anywhere on the server. {@link readJournalLag} says how
 * long it has been holding entries back, so the service can warn when that
 * exceeds the convergence bound it advertises.
 */
import type postgres from "postgres";

/** Why a new epoch started. */
export type JournalRestartReason =
  | "requested"
  | "database-replaced"
  | "transaction-ids-went-back"
  | "timeline-changed";

/**
 * Which database the journal is in: its OID, and the cluster's system
 * identifier, both as decimal text, each null when it cannot be read.
 */
export interface JournalIdentity {
  databaseOid: string | null;
  systemIdentifier: string | null;
}

export type JournalEpochResult =
  | { epoch: string; started: false }
  | { epoch: string; started: true; reason: JournalRestartReason };

/** How often the epoch transaction is tried when it waits too long for the journal's lock. */
export const JOURNAL_EPOCH_ATTEMPTS = 6;

/** SQLSTATE of a lock wait past the session's `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * The Postgres timeline this server runs on, or null when it cannot be read:
 * `pg_control_checkpoint()` may need a privilege the role does not have.
 * Read in its own statement, outside any transaction, so a refusal aborts
 * nothing.
 */
async function readTimeline(sql: postgres.Sql): Promise<number | null> {
  try {
    const [row] = await sql<{ timeline_id: number | null }[]>`
      SELECT timeline_id FROM pg_control_checkpoint()`;
    return typeof row?.timeline_id === "number" ? row.timeline_id : null;
  } catch {
    return null;
  }
}

/**
 * The database's OID and the cluster's system identifier. The identifier is
 * read best effort, as the timeline is: `pg_control_system()` may need a
 * privilege the role does not have, so it is read in its own statement,
 * outside any transaction, and is null when refused.
 */
async function readIdentity(sql: postgres.Sql): Promise<JournalIdentity> {
  let databaseOid: string | null = null;
  try {
    const [row] = await sql<{ oid: string }[]>`
      SELECT oid::bigint::text AS oid FROM pg_database WHERE datname = current_database()`;
    databaseOid = row?.oid ?? null;
  } catch {
    databaseOid = null;
  }
  let systemIdentifier: string | null = null;
  try {
    const [row] = await sql<{ system_identifier: string | null }[]>`
      SELECT system_identifier::text AS system_identifier FROM pg_control_system()`;
    systemIdentifier = row?.system_identifier ?? null;
  } catch {
    systemIdentifier = null;
  }
  return { databaseOid, systemIdentifier };
}

class EpochLockTimeout extends Error {}

/**
 * Makes sure the journal belongs to the database's current history, starting
 * a new epoch when the row is missing (`requested`), when the database's OID
 * or the cluster's system identifier differs from the stored one
 * (`database-replaced`), when transaction ids went back
 * (`transaction-ids-went-back`) or when the Postgres timeline changed
 * (`timeline-changed`). Otherwise it notes how far the transaction ids got,
 * and the timeline, OID and identifier where they were not yet known. A value
 * that cannot be read now is compared with nothing. `identity` replaces what
 * is read of the database; tests use it to stand for another database. Starting an epoch empties the
 * journal of all but its delete entries and sets every subscription's push
 * cursor back to the start, in one transaction serialized by an advisory
 * lock, so two callers never both start one. Emptying the journal waits for its lock; a wait past the pool's
 * `lock_timeout` is tried again, {@link JOURNAL_EPOCH_ATTEMPTS} times in all,
 * before it throws.
 */
export async function ensureJournalEpoch(
  sql: postgres.Sql,
  opts: { now: string; log?: (line: string) => void; identity?: JournalIdentity },
): Promise<JournalEpochResult> {
  const timeline = await readTimeline(sql);
  const identity = opts.identity ?? (await readIdentity(sql));
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await sql.begin(async (tx) => {
        try {
          return await epochTransaction(tx, timeline, identity, opts.now);
        } catch (err) {
          if ((err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
            throw new EpochLockTimeout(String(err));
          }
          throw err;
        }
      });
      if (result.started) {
        opts.log?.(`journal epoch ${result.epoch} started: ${result.reason}`);
      }
      return result;
    } catch (err) {
      if (!(err instanceof EpochLockTimeout) || attempt >= JOURNAL_EPOCH_ATTEMPTS) {
        if (err instanceof EpochLockTimeout) {
          throw new Error(
            `the journal could not be locked to start a new epoch after ${attempt} attempts: ${err.message}`,
          );
        }
        throw err;
      }
    }
  }
}

async function epochTransaction(
  tx: postgres.TransactionSql,
  timeline: number | null,
  identity: JournalIdentity,
  now: string,
): Promise<JournalEpochResult> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('conditions.federation_journal'))`;
  // Both comparisons against one snapshot's xmax: a committed entry always
  // has a txid below the xmax of a snapshot that sees it, so `>=` never holds
  // in a healthy database; `seen_xid` takes a strict `>` because an idle
  // database can still be exactly where it was.
  const [row] = await tx<
    {
      epoch: string;
      timeline_id: number | null;
      database_oid: string | null;
      system_identifier: string | null;
      ids_back: boolean;
      journal_ahead: boolean;
    }[]
  >`
    WITH s AS (SELECT pg_snapshot_xmax(pg_current_snapshot()) AS xmax)
    SELECT j.epoch::text AS epoch, j.timeline_id,
           j.database_oid::text AS database_oid, j.system_identifier::text AS system_identifier,
           j.seen_xid > s.xmax AS ids_back,
           coalesce((SELECT o.txid FROM conditions.federation_outbox o
                      ORDER BY o.txid DESC, o.seq DESC LIMIT 1) >= s.xmax, false) AS journal_ahead
      FROM conditions.federation_journal j, s`;

  const differs = (stored: string | number | null, current: string | number | null) =>
    stored !== null && current !== null && stored !== current;
  let reason: JournalRestartReason = "requested";
  if (row !== undefined) {
    if (
      differs(row.database_oid, identity.databaseOid) ||
      differs(row.system_identifier, identity.systemIdentifier)
    ) {
      reason = "database-replaced";
    } else if (row.ids_back || row.journal_ahead) reason = "transaction-ids-went-back";
    else if (differs(row.timeline_id, timeline)) reason = "timeline-changed";
    else {
      await tx`
        UPDATE conditions.federation_journal
           SET seen_xid = pg_snapshot_xmax(pg_current_snapshot()),
               timeline_id = coalesce(timeline_id, ${timeline}::integer),
               database_oid = coalesce(database_oid, ${identity.databaseOid}::bigint),
               system_identifier = coalesce(system_identifier, ${identity.systemIdentifier}::bigint)`;
      return { epoch: row.epoch, started: false };
    }
  }

  // The seed journals what is live again, but nothing would journal a
  // retraction again: a delete or an erasure a subscriber has not read yet
  // would never reach it. The delete entries are carried into the new epoch
  // under this transaction's id, in their old order, with the time they were
  // journalled at, so each tier's window still decides who is served them.
  await tx`
    CREATE TEMP TABLE federation_journal_carried ON COMMIT DROP AS
    SELECT * FROM conditions.federation_outbox WHERE operation = 'delete'`;
  await tx`TRUNCATE conditions.federation_outbox`;
  await tx`UPDATE federation_journal_carried SET txid = pg_current_xact_id()`;
  await tx`INSERT INTO conditions.federation_outbox SELECT * FROM federation_journal_carried`;
  await tx`
    UPDATE conditions.federation_subscription
       SET cursor = '0.0', revision = revision + 1, updated_at = ${now}`;
  await tx`DELETE FROM conditions.federation_journal`;
  const [started] = await tx<{ epoch: string }[]>`
    INSERT INTO conditions.federation_journal
      (epoch, started_at, seen_xid, timeline_id, database_oid, system_identifier)
    VALUES (gen_random_uuid(), ${now}, pg_snapshot_xmax(pg_current_snapshot()),
            ${timeline}::integer, ${identity.databaseOid}::bigint,
            ${identity.systemIdentifier}::bigint)
    RETURNING epoch::text AS epoch`;
  if (started === undefined) throw new Error("the new journal epoch was not written");
  return { epoch: started.epoch, started: true, reason };
}

/**
 * Notes how far the transaction ids got, between boots. Only ever forwards:
 * a stored value ahead of the counter is what tells the next boot that the
 * ids went back.
 */
export async function advanceJournalSeenXid(sql: postgres.Sql): Promise<void> {
  await sql`
    UPDATE conditions.federation_journal
       SET seen_xid = s.xmax
      FROM (SELECT pg_snapshot_xmax(pg_current_snapshot()) AS xmax) s
     WHERE seen_xid < s.xmax`;
}

export interface JournalLag {
  epoch: string;
  /** When the oldest committed entry the fence still holds back was journalled; null when none is. */
  heldSince: string | null;
  /** Seconds since {@link heldSince}; 0 when nothing is held back. */
  lagSec: number;
}

/**
 * How long the fence has been holding back committed entries: the oldest
 * committed entry at or past the snapshot's xmin is one no page serves yet.
 */
export async function readJournalLag(sql: postgres.Sql, now: string): Promise<JournalLag> {
  const [row] = await sql<{ epoch: string; held_since: Date | null }[]>`
    SELECT j.epoch::text AS epoch,
           (SELECT o.created_at FROM conditions.federation_outbox o
             WHERE o.txid >= pg_snapshot_xmin(pg_current_snapshot())
             ORDER BY o.txid, o.seq LIMIT 1) AS held_since
      FROM conditions.federation_journal j`;
  if (row === undefined) throw new Error("conditions.federation_journal has no row");
  if (row.held_since === null) return { epoch: row.epoch, heldSince: null, lagSec: 0 };
  const lagSec = Math.max(0, Math.floor((Date.parse(now) - row.held_since.getTime()) / 1000));
  return { epoch: row.epoch, heldSince: row.held_since.toISOString(), lagSec };
}

/** The session whose open transaction holds the fence back, as far as this role may see it. */
export interface FenceHolder {
  applicationName: string | null;
  xactStart: string | null;
}

/**
 * The session with the oldest transaction id, best effort: without
 * `pg_read_all_stats` another role's sessions show no application name or
 * start, and any error yields null.
 */
export async function readFenceHolder(sql: postgres.Sql): Promise<FenceHolder | null> {
  try {
    const [row] = await sql<{ application_name: string | null; xact_start: Date | null }[]>`
      SELECT application_name, xact_start FROM pg_stat_activity
       WHERE backend_xid IS NOT NULL
       ORDER BY age(backend_xid) DESC LIMIT 1`;
    if (row === undefined) return null;
    return {
      applicationName: row.application_name || null,
      xactStart: row.xact_start === null ? null : row.xact_start.toISOString(),
    };
  } catch {
    return null;
  }
}

/** How often a lag that lasts is warned about again. */
export const JOURNAL_LAG_REWARN_MS = 10 * 60 * 1000;

/** What the lag check remembers between runs. */
export interface JournalLagWatch {
  /** When the current excess was last warned about; null while the lag is within the bound. */
  warnedAt: number | null;
}

/**
 * Whether a lag check logs: `warn` when the lag first exceeds `boundSec` and
 * again at most every {@link JOURNAL_LAG_REWARN_MS} while it lasts, `recovered`
 * once when it is back within the bound, otherwise nothing.
 */
export function journalLagNotice(
  watch: JournalLagWatch,
  lagSec: number,
  boundSec: number,
  nowMs: number,
): { notice: "warn" | "recovered" | null; watch: JournalLagWatch } {
  if (lagSec > boundSec) {
    if (watch.warnedAt !== null && nowMs - watch.warnedAt < JOURNAL_LAG_REWARN_MS) {
      return { notice: null, watch };
    }
    return { notice: "warn", watch: { warnedAt: nowMs } };
  }
  if (watch.warnedAt !== null) return { notice: "recovered", watch: { warnedAt: null } };
  return { notice: null, watch };
}
