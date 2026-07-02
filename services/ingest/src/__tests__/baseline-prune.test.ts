import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { pruneSpeedSamples } from "../pipeline/baseline-derive.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

async function seedSample(sensorKey: string, observedAt: Date): Promise<void> {
  await sql`
    INSERT INTO conditions.sensor_speed_sample
      (sensor_key, source, observed_at, speed_kph, dow, tod_hour, geom)
    VALUES (${sensorKey}, 'src', ${observedAt}, 80, 1, 8,
      ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[0,0]}'), 4326))`;
}

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

describe("pruneSpeedSamples", () => {
  it("deletes samples older than the retention window", async () => {
    const now = Date.now();
    await seedSample("keep", new Date(now - 10 * 86_400_000));
    await seedSample("drop", new Date(now - 40 * 86_400_000));
    const { deleted } = await pruneSpeedSamples(sql, { retentionDays: 35 });
    expect(deleted).toBe(1);
    const rows = await sql<{ sensor_key: string }[]>`
      SELECT sensor_key FROM conditions.sensor_speed_sample ORDER BY sensor_key`;
    expect(rows.map((r) => r.sensor_key)).toEqual(["keep"]);
  }, 30_000);

  it("defaults retentionDays to 35 when opts are omitted", async () => {
    const now = Date.now();
    await seedSample("default-keep", new Date(now - 20 * 86_400_000));
    await seedSample("default-drop", new Date(now - 36 * 86_400_000));
    const { deleted } = await pruneSpeedSamples(sql);
    expect(deleted).toBe(1);
    const rows = await sql<{ sensor_key: string }[]>`
      SELECT sensor_key FROM conditions.sensor_speed_sample WHERE sensor_key LIKE 'default-%'
      ORDER BY sensor_key`;
    expect(rows.map((r) => r.sensor_key)).toEqual(["default-keep"]);
  }, 30_000);
});
