import {
  expectedSchemaVersion,
  runMigrations,
  waitForSchemaVersion,
} from "@openconditions/core/server";
import {
  createTestDatabase,
  createTestRole,
  type TestDatabase,
  type TestRole,
} from "@openconditions/test-database";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The contributions service migrates nothing: at boot it waits until the
 * ingest service has brought the schema to this build's version, reading the
 * migration history with its own role, which has no DDL rights.
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

/** A role for the contributions service with a connection to `db`. */
async function contributionsRole(db: TestDatabase): Promise<{ role: TestRole; sql: postgres.Sql }> {
  const role = await createTestRole(db);
  roles.push(role);
  const sql = postgres(role.url, { max: 1, onnotice: () => {} });
  clients.push(sql);
  return { role, sql };
}

/** What the contributions role needs to read the version; the custom migration will grant it. */
async function grantVersionRead(db: TestDatabase, role: TestRole): Promise<void> {
  await db.sql.unsafe(`GRANT USAGE ON SCHEMA conditions TO "${role.name}"`);
  await db.sql.unsafe(`GRANT SELECT ON conditions.__drizzle_migrations TO "${role.name}"`);
}

describe("waitForSchemaVersion", () => {
  it("lets the service start without DDL rights once the ingest service migrated", async () => {
    const db = await database();
    const { role, sql } = await contributionsRole(db);
    await grantVersionRead(db, role);

    await expect(sql`CREATE TABLE conditions.probe (id int)`).rejects.toMatchObject({
      code: "42501",
    });
    await expect(sql`CREATE SCHEMA probe`).rejects.toMatchObject({ code: "42501" });
    await expect(waitForSchemaVersion(sql, { timeoutMs: 5_000 })).resolves.toBeUndefined();
  });

  it("waits while the ingest service migrates, then resolves", async () => {
    const db = await database({ empty: true });
    const { role, sql } = await contributionsRole(db);
    const told: string[] = [];
    const waiting = waitForSchemaVersion(sql, {
      timeoutMs: 60_000,
      pollMs: 100,
      onWait: (found) => told.push(found),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await runMigrations(db.url);
    await grantVersionRead(db, role);
    await expect(waiting).resolves.toBeUndefined();
    expect(told).toEqual(["conditions.__drizzle_migrations does not exist"]);
  }, 60_000);

  it("fails clearly when the ingest service has not migrated", async () => {
    const db = await database({ empty: true });
    const { sql } = await contributionsRole(db);
    await expect(waitForSchemaVersion(sql, { timeoutMs: 300, pollMs: 100 })).rejects.toThrow(
      `the database schema did not reach this build's version within 300 ms: expected a migration in conditions.__drizzle_migrations with when ${expected.when} (${expected.tag}) or later, but conditions.__drizzle_migrations does not exist.`,
    );
  });

  it("fails clearly when the schema is older than this build", async () => {
    const db = await database();
    const { role, sql } = await contributionsRole(db);
    await grantVersionRead(db, role);
    await db.sql`DELETE FROM conditions.__drizzle_migrations WHERE created_at = ${expected.when}`;
    const [older] = await db.sql<{ when: string }[]>`
      SELECT max(created_at)::text AS when FROM conditions.__drizzle_migrations`;
    expect(Number(older!.when)).toBeLessThan(expected.when);
    await expect(waitForSchemaVersion(sql, { timeoutMs: 300, pollMs: 100 })).rejects.toThrow(
      `but the latest recorded migration has when ${older!.when}.`,
    );
  });

  it("fails clearly when the role may not read the history", async () => {
    const db = await database();
    const { sql } = await contributionsRole(db);
    await expect(waitForSchemaVersion(sql, { timeoutMs: 300, pollMs: 100 })).rejects.toThrow(
      /conditions\.__drizzle_migrations cannot be read by this role \(permission denied for schema conditions\); it needs USAGE on the schema conditions and SELECT on the table/,
    );
  });

  it("is not blocked by a newer ingest that applied later migrations", async () => {
    const db = await database();
    const { role, sql } = await contributionsRole(db);
    await grantVersionRead(db, role);
    // What a later release's ingest records for a migration this build does not ship.
    await db.sql`INSERT INTO conditions.__drizzle_migrations (hash, created_at)
      VALUES ('later', ${expected.when + 86_400_000})`;
    await expect(
      waitForSchemaVersion(sql, { timeoutMs: 300, pollMs: 100 }),
    ).resolves.toBeUndefined();
  });
});
