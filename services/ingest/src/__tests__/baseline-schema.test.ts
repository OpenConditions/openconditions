import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";

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
  it("creates sensor_speed_sample with an append-only row", async () => {
    await sql`
      INSERT INTO conditions.sensor_speed_sample
        (sensor_key, source, observed_at, speed_kph, dow, tod_hour, geom)
      VALUES ('src:1', 'src', now(), 88.0, 3, 14,
        ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[24.9,60.2]}'), 4326))`;
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.sensor_speed_sample WHERE sensor_key = 'src:1'`;
    expect(rows[0]!.n).toBe(1);
  }, 30_000);

  it("upserts sensor_baseline on its composite PK", async () => {
    await sql`
      INSERT INTO conditions.sensor_baseline
        (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('src:1', 'src', -1, -1, 100.0, 'derived', 42, now())`;
    await sql`
      INSERT INTO conditions.sensor_baseline
        (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('src:1', 'src', -1, -1, 110.0, 'derived', 50, now())
      ON CONFLICT (sensor_key, dow_bucket, tod_bucket, method)
      DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, sample_count = EXCLUDED.sample_count`;
    const rows = await sql<{ free_flow_kph: number; n: number }[]>`
      SELECT free_flow_kph, sample_count AS n FROM conditions.sensor_baseline
      WHERE sensor_key = 'src:1' AND method = 'derived'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.free_flow_kph).toBe(110);
  }, 30_000);
});
