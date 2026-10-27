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
