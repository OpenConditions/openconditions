import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { runMigrations } from "@openconditions/core/server";

/**
 * A disposable PostGIS database for the restriction suites, using the same
 * image and migrations as the rest of the integration tests. Test-only: no
 * runtime module imports this helper.
 */
export async function createRestrictionDatabase(): Promise<{
  sql: postgres.Sql;
  url: string;
  close(): Promise<void>;
}> {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  const sql = postgres(url, { max: 3 });
  try {
    await runMigrations(url);
  } catch (error) {
    await sql.end();
    await container.stop();
    throw error;
  }
  return {
    sql,
    url,
    async close() {
      try {
        await sql.end();
      } finally {
        await container.stop();
      }
    },
  };
}
