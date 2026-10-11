import { runMigrations } from "@openconditions/core/server";
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
 * A disposable PostGIS database with every migration applied, for the
 * storage suites. Test-only: no runtime module imports this helper.
 */
export async function createTestDatabase(): Promise<{
  sql: postgres.Sql;
  url: string;
  close(): Promise<void>;
}> {
  const profile = process.env["OC_TEST_POSTGIS_PROFILE"] ?? "pg16";
  if (profile !== "pg16" && profile !== "pg18") {
    throw new Error(`Unsupported OC_TEST_POSTGIS_PROFILE: ${profile}`);
  }
  const image =
    profile === "pg18"
      ? "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8"
      : "postgis/postgis:16-3.4";
  const container = await new GenericContainer(image)
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
    if (
      typeof server_version_num !== "string" ||
      !/^\d+$/.test(server_version_num) ||
      !Number.isSafeInteger(Number(server_version_num)) ||
      Math.floor(Number(server_version_num) / 10000) !== (profile === "pg18" ? 18 : 16)
    ) {
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
