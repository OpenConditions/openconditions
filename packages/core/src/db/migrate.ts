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
 * drops its history with it. Idempotent. Only the ingest service's processes
 * (the primary and, when enabled, the heavy-feeds process) run it at boot;
 * the other services wait for its result with `waitForSchemaVersion`.
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
 *
 * After the migrations it grants the roles of OpenMapX's traffic tile and the
 * contributions service what they use ({@link grantConsumerRoles}), so a role
 * created after the first migrate gets its grants at the next start.
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
    // The grants run after the migration has committed, in a statement of
    // their own. Once an incremental migration adds a table a consumer uses,
    // a consumer that starts in between can see the new version, pass its
    // schema wait and get "permission denied" on the new table until this
    // call lands a moment later. That is acceptable: the window lasts one
    // function call under the migration lock, and a refused query fails one
    // request, one sweep run or one start (which the restart policy repeats)
    // rather than writing anything wrong; the next attempt succeeds. A
    // migration that must close it re-creates conditions.grant_consumer_roles()
    // with the new table and calls it in the same file, which the custom
    // migration's statement-kind test must then allow.
    await grantConsumerRoles(client);
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

/**
 * Runs `conditions.grant_consumer_roles()`, which grants each consumer role
 * that exists exactly what it uses; re-granting changes nothing. A grant
 * rewrites catalog rows another session of the same role (the federation
 * service maintaining partitions) may be updating at that moment, which
 * PostgreSQL refuses with "tuple concurrently updated"; that is tried once
 * more.
 */
export async function grantConsumerRoles(client: postgres.Sql): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client`SELECT conditions.grant_consumer_roles()`;
      return;
    } catch (error) {
      if (attempt > 1 || !isConcurrentCatalogUpdate(error)) throw error;
    }
  }
}

function isConcurrentCatalogUpdate(error: unknown): boolean {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "40001" ||
    (code === "XX000" &&
      typeof message === "string" &&
      message.includes("tuple concurrently updated"))
  );
}
