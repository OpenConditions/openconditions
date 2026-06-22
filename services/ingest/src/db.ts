import postgres from "postgres";

const url = process.env["DATABASE_URL"];

if (!url) {
  throw new Error("DATABASE_URL environment variable is required");
}

/** The validated connection string (used both for the app pool and, by
 * runMigrations, for its own short-lived migration connection). */
export const DATABASE_URL: string = url;

/**
 * Shared postgres-js client. The ingest service opens a single pool
 * and reuses it across all pipeline runs and Fastify request handlers.
 */
export const sql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
});
