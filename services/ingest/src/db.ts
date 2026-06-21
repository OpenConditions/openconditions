import postgres from "postgres";

const DATABASE_URL = process.env["DATABASE_URL"];

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

/**
 * Shared postgres-js client. The ingest service opens a single pool
 * and reuses it across all pipeline runs and Fastify request handlers.
 */
export const sql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
});
