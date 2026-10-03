import { runMigrations } from "@openconditions/core/server";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("baseline schema", () => {
  it("holds no legacy observation or speed-sample tables", async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'conditions' AND table_name IN
         ('observations', 'sensor_speed_sample', 'sensor_speed_hourly', 'speed_rollup_progress')`;
    expect(rows).toEqual([]);
  }, 30_000);

  it("upserts sensor_baseline on its composite PK", async () => {
    await sql`
      INSERT INTO conditions.sensor_baseline
        (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('feature:oc:feature:src:1', 'src', -1, -1, 100.0, 'derived', 42, now())`;
    await sql`
      INSERT INTO conditions.sensor_baseline
        (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('feature:oc:feature:src:1', 'src', -1, -1, 110.0, 'derived', 50, now())
      ON CONFLICT (subject_key, dow_bucket, tod_bucket, method)
      DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, sample_count = EXCLUDED.sample_count`;
    const rows = await sql<{ free_flow_kph: number; n: number }[]>`
      SELECT free_flow_kph, sample_count AS n FROM conditions.sensor_baseline
      WHERE subject_key = 'feature:oc:feature:src:1' AND method = 'derived'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.free_flow_kph).toBe(110);
  }, 30_000);
});
