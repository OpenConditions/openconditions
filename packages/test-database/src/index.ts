import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { inject } from "vitest";
import type { PostgisProfile } from "./profile.js";

/**
 * Disposable databases for the integration suites. One PostGIS server per run
 * holds a migrated template (the root Vitest global setup starts it); each
 * suite clones its own database from that template and drops it on close.
 * Test-only: no runtime module imports this package.
 */

export {
  assertPostgisProfile,
  POSTGIS_IMAGES,
  type PostgisProfile,
  postgisProfile,
  runsProfile,
} from "./profile.js";

/** The shared server, as the global setup provides it to every suite. */
export interface SharedPostgis {
  profile: PostgisProfile;
  /** A superuser connection to the server's maintenance database. */
  adminUrl: string;
  /** The migrated database every suite clones. */
  template: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    postgis: SharedPostgis;
  }
}

export interface TestDatabase {
  sql: postgres.Sql;
  url: string;
  close(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** Pool options of the returned client. */
  pool?: postgres.Options<Record<string, postgres.PostgresType>>;
  /** Start from an empty database rather than the migrated template. */
  empty?: boolean;
}

/** A login role on the shared server, as a service's own database role. */
export interface TestRole {
  name: string;
  /** The test database's URL, logging in as this role. */
  url: string;
  /** Drops the role; close every database it holds objects or grants in first. */
  drop(): Promise<void>;
}

/**
 * A login role with no privileges beyond PUBLIC's, for testing what a
 * service's own role may do in `database`. Roles belong to the whole server,
 * so each gets a unique name.
 */
export async function createTestRole(database: TestDatabase): Promise<TestRole> {
  const shared = inject("postgis");
  if (!shared) throw new Error("No shared PostGIS server: run the integration Vitest project");
  const name = `r_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID().replaceAll("-", "");
  await administer(shared.adminUrl, (admin) =>
    admin.unsafe(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}'`),
  );
  const url = new URL(database.url);
  url.username = name;
  url.password = password;
  return {
    name,
    url: url.toString(),
    async drop() {
      await administer(shared.adminUrl, (admin) => admin.unsafe(`DROP ROLE IF EXISTS "${name}"`));
    },
  };
}

/**
 * A secrets key (`OPENCONDITIONS_SECRETS_KEY`) for the services' test
 * environments: 64 hexadecimal characters, as an operator generates with
 * `openssl rand -hex 32`. It seals only throwaway test data.
 */
export const TEST_SECRETS_KEY = "5ec7e75ec7e75ec7e75ec7e75ec7e75ec7e75ec7e75ec7e75ec7e75ec7e75ec7";

/**
 * The rows of `conditions.<table>` as `pg_dump` writes them: the text output
 * of `COPY … TO STDOUT`, bytea columns in hex. A test searches it for a
 * secret, in clear and as hex, to show a backup does not hold it.
 */
export async function dumpTable(sql: postgres.Sql, table: string): Promise<string> {
  const chunks: Buffer[] = [];
  const stream = await sql.unsafe(`COPY "conditions"."${table}" TO STDOUT`).readable();
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** Whether `dump` holds `secret`, in clear or as the hex `pg_dump` writes bytea in. */
export function dumpHolds(dump: string, secret: Uint8Array | string): boolean {
  const bytes = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  return dump.includes(bytes.toString("utf8")) || dump.includes(bytes.toString("hex"));
}

/**
 * The roles the custom migration grants to by name: the one OpenMapX's
 * traffic tile function runs as, which cannot log in, and the contributions
 * service's login.
 */
export const TILES_OWNER_ROLE = "openmapx_tiles_owner";
export const CONTRIBUTIONS_ROLE = "openconditions_contributions";
/** The contributions role's password on the throwaway test server. */
const CONTRIBUTIONS_PASSWORD = "contributions";

/**
 * Creates the roles the custom migration grants to, as an operator creates
 * them. The global setup calls it once, after migrating the template, so a
 * clone of the template holds no grants to them; a suite that tests the
 * grants migrates an empty database.
 */
export async function createGranteeRoles(adminUrl: string): Promise<void> {
  await administer(adminUrl, (admin) =>
    admin.unsafe(`
      CREATE ROLE ${TILES_OWNER_ROLE} NOLOGIN NOINHERIT;
      CREATE ROLE ${CONTRIBUTIONS_ROLE} LOGIN PASSWORD '${CONTRIBUTIONS_PASSWORD}';
    `),
  );
}

/** `database`'s URL, logging in as the contributions service's role. */
export function contributionsRoleUrl(database: TestDatabase): string {
  const url = new URL(database.url);
  url.username = CONTRIBUTIONS_ROLE;
  url.password = CONTRIBUTIONS_PASSWORD;
  return url.toString();
}

async function administer<T>(adminUrl: string, run: (admin: postgres.Sql) => Promise<T>) {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

/**
 * A fresh database on the shared server: a clone of the migrated template, or
 * empty with `empty`. Closing ends its pool and drops it.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const shared = inject("postgis");
  if (!shared) throw new Error("No shared PostGIS server: run the integration Vitest project");
  const name = `t_${randomUUID().replaceAll("-", "")}`;
  const template = options.empty ? "template0" : shared.template;
  await administer(shared.adminUrl, (admin) =>
    admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`),
  );
  const url = new URL(shared.adminUrl);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 4, onnotice: () => {}, ...options.pool });
  return {
    sql,
    url: url.toString(),
    async close() {
      try {
        await sql.end();
      } finally {
        await administer(shared.adminUrl, (admin) =>
          admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
        );
      }
    },
  };
}
