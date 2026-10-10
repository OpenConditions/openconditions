import { requireCredential } from "@openconditions/ingest-framework";
import postgres from "postgres";

/** The validated connection string (used both for the app pool and, by
 * runMigrations, for its own short-lived migration connection). Read from
 * `DATABASE_URL`, else the file `DATABASE_URL_FILE` names. */
export const DATABASE_URL: string = requireCredential(process.env, "DATABASE_URL");

/**
 * The pipeline's postgres-js client: feed polls, record jobs and the other
 * background work share this pool.
 */
export const sql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
});

/**
 * The HTTP API's own pool. A large poll's transaction can hold a lock other
 * polls queue behind, each holding a pipeline connection while it waits;
 * reads served from that pool then waited with them.
 */
export const apiSql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
});
