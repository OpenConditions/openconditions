import { requireCredential } from "@openconditions/ingest-framework";
import postgres from "postgres";

/** The validated connection string (used both for the app pool and, by
 * runMigrations, for its own short-lived migration connection). Read from
 * `DATABASE_URL`, else the file `DATABASE_URL_FILE` names. */
export const DATABASE_URL: string = requireCredential(process.env, "DATABASE_URL");

/**
 * The pipeline's postgres-js client: feed polls, the binding drain and the
 * segment-speed and fusion refreshes share this pool. Its timeouts are
 * startup parameters, as the database and role may be shared with another
 * application. A poll statement has taken up to 90 s and a poll's write phase
 * two minutes; past five minutes a statement is stuck. A poll waits a minute
 * for a lock (another source's publication linking the same kind) and then
 * fails, to be retried on its next tick, rather than holding a connection
 * for as long as that publication runs.
 */
export const sql = postgres(DATABASE_URL, {
  connection: {
    application_name: "openconditions-ingest-writer",
    statement_timeout: 5 * 60_000,
    lock_timeout: 60_000,
    idle_in_transaction_session_timeout: 10 * 60_000,
  },
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
});

/**
 * The HTTP API's own pool. A large poll's transaction can hold a lock other
 * polls queue behind, each holding a pipeline connection while it waits;
 * reads served from that pool then waited with them. A read, or an on-demand
 * cell's write, that waits seconds for a lock is better failed than holding
 * one of the API's few connections.
 */
export const apiSql = postgres(DATABASE_URL, {
  connection: {
    application_name: "openconditions-ingest-api",
    statement_timeout: 20_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 60_000,
  },
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
});

/**
 * The scheduled maintenance's pool: partitions, rollups, the sweep, raw
 * eviction, poll-history pruning, baselines, the archive and the segment
 * spine. Its statements may run long (a daily rollup, a region's segment
 * build), but none waits more than seconds for a lock: partition DDL queued
 * behind a long publication would stall every write behind it. A job that
 * meets a held lock tries again on its next run.
 */
export const maintenanceSql = postgres(DATABASE_URL, {
  connection: {
    application_name: "openconditions-ingest-maintenance",
    statement_timeout: 60 * 60_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15 * 60_000,
  },
  max: 2,
  idle_timeout: 30,
  connect_timeout: 10,
});
