import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Where the applied migrations are recorded: `conditions.__drizzle_migrations`. */
export const MIGRATIONS_SCHEMA = "conditions";
export const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * Resolves the drizzle-kit migrations folder relative to the running module,
 * tolerating both layouts this code runs in:
 *  - as the published/workspace package: `dist/index.js` → `../drizzle` sibling
 *    (shipped via package `files`);
 *  - inlined into a service bundle: the service's build copies `drizzle/` next
 *    to its entry, so `./drizzle` resolves there.
 */
export function resolveMigrationsFolder(): string {
  const candidates = ["../drizzle", "./drizzle"].map((rel) =>
    fileURLToPath(new URL(rel, import.meta.url)),
  );
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(`drizzle migrations folder not found (looked in: ${candidates.join(", ")})`);
  }
  return found;
}

/**
 * Applies all pending migrations in `packages/core/drizzle/` (a baseline
 * drizzle-kit generates from the schema code, and a custom file with what it
 * cannot express; see docs/database-migrations.md) to the database. Applied
 * migrations are tracked in `conditions.__drizzle_migrations`, inside the
 * schema they describe: the history stays apart from another Drizzle
 * project's in a shared database (OpenMapX keeps its own in `drizzle`), the
 * role that owns `conditions` needs no other schema, and dropping `conditions`
 * drops its history with it. Idempotent. Only the ingest service runs it at
 * boot; the other services wait for its result with `waitForSchemaVersion`.
 *
 * Takes a connection string (not a client) and opens its own short-lived
 * `max: 1` connection: drizzle's postgres-js driver replaces the client's type
 * parsers/serializers with identity functions (it does its own (de)serialization),
 * so handing it the app's shared pool would corrupt every later raw query on
 * that pool. A throwaway client is the drizzle-recommended migration pattern.
 *
 * The PostGIS extension and the `conditions` schema are created here, not in a
 * migration: drizzle-kit cannot model `CREATE EXTENSION`, and the generated
 * migrations reference the `conditions` schema and the `geometry` type, both
 * of which must already exist before the first migration runs.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder();
  // A migration may rewrite a large table, and waits for the locks it needs
  // however long: no timeout the database or role sets applies to it.
  const client = postgres(connectionString, {
    max: 1,
    connection: { statement_timeout: 0, lock_timeout: 0 },
  });
  let locked = false;
  try {
    // One session owns all bootstrap DDL and the migration-history read. Each
    // service has its own process; max:1 pins this lock to this migration session.
    await client`SELECT pg_advisory_lock(hashtext('openconditions'), hashtext('migrations'))`;
    locked = true;
    // Run before drizzle(client) mutates the client's serializers (these have
    // no object/Date params, so native serialization is irrelevant anyway).
    await client`CREATE EXTENSION IF NOT EXISTS postgis`;
    await client`CREATE SCHEMA IF NOT EXISTS conditions`;
    await migrate(drizzle(client), {
      migrationsFolder,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
  } finally {
    try {
      if (locked) {
        await client`SELECT pg_advisory_unlock(hashtext('openconditions'), hashtext('migrations'))`;
      }
    } finally {
      await client.end();
    }
  }
}
