import { requireCredential } from "@openconditions/ingest-framework";
import postgres from "postgres";

/** The validated connection string (used both for the app pool and, by
 * runMigrations, for its own short-lived migration connection). Read from
 * `DATABASE_URL`, else the file `DATABASE_URL_FILE` names. */
export const DATABASE_URL: string = requireCredential(process.env, "DATABASE_URL");

/**
 * Shared postgres-js client. The ingest service opens a single pool
 * and reuses it across all pipeline runs and Fastify request handlers.
 */
export const sql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
});
