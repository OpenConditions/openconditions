import { runMigrations } from "@openconditions/core/server";
import { POSTGIS_IMAGES, postgisProfile, runsProfile } from "@openconditions/test-database";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

async function cleanupDatabase(
  sql: postgres.Sql | undefined,
  container: StartedTestContainer,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    await sql?.end();
  } catch (error) {
    failures.push(error);
  }
  try {
    await container.stop();
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

function throwCleanupFailures(failures: unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Failed to close disposable database");
}

/**
 * A migrated PostGIS database on a server of its own, for the suites that
 * observe the server itself: its physical version, server-wide WAL and its
 * container's removal. Other suites share the run's server through
 * `@openconditions/test-database`. Test-only: no runtime module imports this
 * helper.
 */
export async function createDedicatedTestDatabase(): Promise<{
  sql: postgres.Sql;
  url: string;
  close(): Promise<void>;
}> {
  const profile = postgisProfile();
  const container = await new GenericContainer(POSTGIS_IMAGES[profile])
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  let sql: postgres.Sql | undefined;
  try {
    const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
    const pool = postgres(url, { max: 4, onnotice: () => {} });
    sql = pool;
    const [{ server_version_num } = {}] = await pool`SHOW server_version_num`;
    if (!runsProfile(server_version_num, profile)) {
      throw new Error(`Unexpected PostgreSQL version for ${profile}`);
    }
    await runMigrations(url);
    return {
      sql: pool,
      url,
      async close() {
        throwCleanupFailures(await cleanupDatabase(pool, container));
      },
    };
  } catch (error) {
    const failures = await cleanupDatabase(sql, container);
    if (failures.length) {
      throw new AggregateError(
        [error, ...failures],
        "Disposable database setup and cleanup failed",
      );
    }
    throw error;
  }
}
