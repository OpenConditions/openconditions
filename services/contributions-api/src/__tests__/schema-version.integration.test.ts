import {
  expectedSchemaVersion,
  runMigrations,
  waitForSchemaVersion,
} from "@openconditions/core/server";
import {
  contributionsRoleUrl,
  createTestDatabase,
  createTestRole,
  type TestDatabase,
  type TestRole,
} from "@openconditions/test-database";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The contributions service migrates nothing: at boot it waits until the
 * ingest service has brought the schema to this build's version, reading the
 * migration history with its own role, which has no DDL rights. The custom
 * migration grants that role the read; a role it does not know gets none.
 */

const expected = expectedSchemaVersion();

/** Closed after each test in this order: the role's clients, the databases, then the roles. */
const clients: postgres.Sql[] = [];
const databases: TestDatabase[] = [];
const roles: TestRole[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.end();
  for (const db of databases.splice(0)) await db.close();
  for (const role of roles.splice(0)) await role.drop();
});

async function database(options: { empty?: boolean } = {}): Promise<TestDatabase> {
  const db = await createTestDatabase(options);
  databases.push(db);
  return db;
}

function connect(url: string): postgres.Sql {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  clients.push(sql);
  return sql;
}

/** A database the ingest service migrated while the contributions role existed. */
async function migrated(): Promise<TestDatabase> {
  const db = await database({ empty: true });
  await runMigrations(db.url);
  return db;
}

/** The contributions service's own role, with the grants the migration gave it. */
function asContributions(db: TestDatabase): postgres.Sql {
  return connect(contributionsRoleUrl(db));
}

/** A role the migration grants nothing, with a connection to `db`. */
async function ungranted(db: TestDatabase): Promise<postgres.Sql> {
  const role = await createTestRole(db);
  roles.push(role);
  return connect(role.url);
}

describe("waitForSchemaVersion", () => {
  it("lets the service start without DDL rights once the ingest service migrated", async () => {
    const sql = asContributions(await migrated());

    await expect(sql`CREATE TABLE conditions.probe (id int)`).rejects.toMatchObject({
      code: "42501",
    });
    await expect(sql`CREATE SCHEMA probe`).rejects.toMatchObject({ code: "42501" });
    await expect(waitForSchemaVersion(sql, { timeoutMs: 5_000 })).resolves.toBeUndefined();
  }, 60_000);

  it("waits while the ingest service migrates, then resolves", async () => {
    const db = await database({ empty: true });
    const sql = asContributions(db);
    const told: string[] = [];
    const waiting = waitForSchemaVersion(sql, {
      timeoutMs: 60_000,
      pollMs: 100,
      onWait: (found) => told.push(found),
    });
    await vi.waitFor(() => expect(told).toHaveLength(1), { timeout: 10_000 });
    await runMigrations(db.url);
    await expect(waiting).resolves.toBeUndefined();
    // The schema exists a moment before the migration that grants the read commits.
    expect(told[0]).toBe("conditions.__drizzle_migrations does not exist");
    for (const later of told.slice(1)) expect(later).toMatch(/cannot be read by this role/);
  }, 60_000);

  it("tells again when what it finds changes", async () => {
    const db = await database({ empty: true });
    const sql = await ungranted(db);
    const told: string[] = [];
    const waiting = waitForSchemaVersion(sql, {
      timeoutMs: 10_000,
      pollMs: 100,
      onWait: (found) => told.push(found),
    });
    const settled = waiting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(told).toHaveLength(1), { timeout: 5_000 });
    // The history appears, but this role was given no read of it.
    await db.sql`CREATE SCHEMA conditions`;
    await db.sql`CREATE TABLE conditions.__drizzle_migrations
      (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
    await vi.waitFor(() => expect(told).toHaveLength(2), { timeout: 5_000 });
    expect(told).toEqual([
      "conditions.__drizzle_migrations does not exist",
      expect.stringMatching(
        /^conditions\.__drizzle_migrations cannot be read by this role \(permission denied for schema conditions\)/,
      ),
    ]);
    expect(await settled).toBeInstanceOf(Error);
  }, 30_000);

  it("fails clearly when the ingest service has not migrated", async () => {
    const sql = asContributions(await database({ empty: true }));
    await expect(waitForSchemaVersion(sql, { timeoutMs: 300, pollMs: 100 })).rejects.toThrow(
      `the database schema did not reach this build's version within 300 ms: expected a migration in conditions.__drizzle_migrations with when ${expected.when} (${expected.tag}) or later, but conditions.__drizzle_migrations does not exist.`,
    );
  });

  it("fails clearly when the schema is older than this build", async () => {
    const db = await migrated();
    const sql = asContributions(db);
    await db.sql`DELETE FROM conditions.__drizzle_migrations WHERE created_at = ${expected.when}`;
    const [older] = await db.sql<{ when: string }[]>`
      SELECT max(created_at)::text AS when FROM conditions.__drizzle_migrations`;
    expect(Number(older!.when)).toBeLessThan(expected.when);
    await expect(waitForSchemaVersion(sql, { timeoutMs: 300, pollMs: 100 })).rejects.toThrow(
      `but the latest recorded migration has when ${older!.when}.`,
    );
  }, 60_000);

  it("fails clearly when the role may not read the history", async () => {
    const sql = await ungranted(await database());
    await expect(waitForSchemaVersion(sql, { timeoutMs: 300, pollMs: 100 })).rejects.toThrow(
      /conditions\.__drizzle_migrations cannot be read by this role \(permission denied for schema conditions\); it needs USAGE on the schema conditions and SELECT on the table/,
    );
  });

  it("ends the wait at once on any other database error", async () => {
    const db = await database({ empty: true });
    // A history table drizzle did not make: it has no created_at.
    await db.sql`CREATE SCHEMA conditions`;
    await db.sql`CREATE TABLE conditions.__drizzle_migrations (id serial PRIMARY KEY, hash text)`;
    const started = Date.now();
    await expect(
      waitForSchemaVersion(db.sql, { timeoutMs: 60_000, pollMs: 100 }),
    ).rejects.toMatchObject({ code: "42703" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("is not blocked by a newer ingest that applied later migrations", async () => {
    const db = await migrated();
    const sql = asContributions(db);
    // What a later release's ingest records for a migration this build does not ship.
    await db.sql`INSERT INTO conditions.__drizzle_migrations (hash, created_at)
      VALUES ('later', ${expected.when + 86_400_000})`;
    await expect(
      waitForSchemaVersion(sql, { timeoutMs: 300, pollMs: 100 }),
    ).resolves.toBeUndefined();
  }, 60_000);
});
