import { runMigrations } from "@openconditions/core/server";
import {
  assertPostgisProfile,
  POSTGIS_IMAGES,
  postgisProfile,
} from "@openconditions/test-database";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { TestProject } from "vitest/node";

const TEMPLATE = "conditions_template";

/**
 * Starts one PostGIS server for the integration project and migrates a
 * template database on it, which each suite clones through
 * `@openconditions/test-database`.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const profile = postgisProfile();
  const container = await start(POSTGIS_IMAGES[profile]);
  try {
    const server = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}`;
    const adminUrl = `${server}/postgres`;
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    try {
      await assertPostgisProfile(admin, profile, {
        fixture: "postgis-global-setup.integration.ts",
        containerId: container.getId(),
      });
      await runMigrations(`${server}/${TEMPLATE}`);
      // Cloning needs the template free of sessions; refusing them keeps it so.
      await admin.unsafe(
        `ALTER DATABASE "${TEMPLATE}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
      );
    } finally {
      await admin.end();
    }
    project.provide("postgis", { profile, adminUrl, template: TEMPLATE });
  } catch (error) {
    await container.stop();
    throw error;
  }
  return async () => {
    await container.stop();
  };
}

/**
 * Testcontainers allows a fixed 10 s for the port binding to appear, which a
 * loaded host can miss; the one server of the run gets a few attempts.
 */
async function start(image: string, attempts = 3): Promise<StartedTestContainer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await new GenericContainer(image)
        .withEnvironment({ POSTGRES_DB: TEMPLATE, POSTGRES_USER: "oc", POSTGRES_PASSWORD: "oc" })
        // Every suite of the run connects to this one server, and nothing on it outlives the run.
        .withCommand(["postgres", "-c", "max_connections=300", "-c", "fsync=off"])
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .withStartupTimeout(120_000)
        .start();
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
  }
}
