import { assertPostgisProfile, postgisProfile, runsProfile } from "@openconditions/test-database";
import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startDatabase } from "./record-fixtures.integration.js";

const databases: Awaited<ReturnType<typeof startDatabase>>[] = [];
const owned: StartedTestContainer[] = [];

async function startOwned() {
  const start = GenericContainer.prototype.start;
  const receipt = vi
    .spyOn(GenericContainer.prototype, "start")
    .mockImplementationOnce(async function (this: GenericContainer) {
      const container = await start.call(this);
      owned.push(container);
      return container;
    });
  try {
    const db = await startDatabase();
    databases.push(db);
    return db;
  } finally {
    receipt.mockRestore();
  }
}

beforeAll(async () => {
  await startOwned();
  await startOwned();
}, 180_000);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const db of databases) {
    try {
      await db.close();
    } catch (error) {
      failures.push(error);
    }
  }
  const runtime = await getContainerRuntimeClient();
  for (const container of owned) {
    try {
      await expect(
        runtime.container.inspect(runtime.container.getById(container.getId())),
      ).rejects.toMatchObject({ statusCode: 404 });
      console.info("DEDICATED_PROFILE_CONTAINER_ABSENT", container.getId());
    } catch (error) {
      failures.push(error);
      await container.stop();
    }
  }
  if (failures.length) throw new AggregateError(failures, "Dedicated profile cleanup failed");
}, 30_000);

it("runs the requested physical major on every dedicated server", async () => {
  expect(databases).toHaveLength(2);
  for (const db of databases) {
    const [{ server_version_num }] = await db.sql`SHOW server_version_num`;
    expect(runsProfile(server_version_num, postgisProfile())).toBe(true);
  }
});

it("keeps independent physical servers and transaction horizons", async () => {
  const [first, second] = databases;
  if (!first || !second) throw new Error("Dedicated databases not ready");
  const [a] = await first.sql`SELECT system_identifier::text FROM pg_control_system()`;
  const [b] = await second.sql`SELECT system_identifier::text FROM pg_control_system()`;
  expect(a?.["system_identifier"]).not.toBe(b?.["system_identifier"]);
  await first.sql.begin(async (transaction) => {
    await transaction`SET LOCAL application_name = 'profile-horizon-first'`;
    await transaction`SELECT txid_current()`;
    const [active] = await second.sql`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE application_name = 'profile-horizon-first'`;
    expect(active?.["count"]).toBe(0);
  });
});

it("rejects a mismatched physical server before qualifying it", async () => {
  const first = databases[0];
  if (!first) throw new Error("Dedicated database not ready");
  await expect(
    assertPostgisProfile(first.sql, postgisProfile() === "pg16" ? "pg18" : "pg16", {
      fixture: "deliberate-mismatch",
      containerId: owned[0]!.getId(),
    }),
  ).rejects.toThrow("Unexpected PostgreSQL version");
});

it("rejects an invalid profile before starting a container", async () => {
  const start = vi.spyOn(GenericContainer.prototype, "start");
  let unexpected: Awaited<ReturnType<typeof startDatabase>> | undefined;
  let failure: unknown;
  vi.stubEnv("OC_TEST_POSTGIS_PROFILE", "unsupported");
  try {
    try {
      unexpected = await startDatabase();
    } catch (error) {
      failure = error;
    } finally {
      await unexpected?.close();
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Unsupported OC_TEST_POSTGIS_PROFILE");
    expect(start).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    start.mockRestore();
  }
});
