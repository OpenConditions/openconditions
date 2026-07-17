import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import {
  BASELINE_WINDOW_DAYS,
  pruneSpeedSamples,
  SPEED_SAMPLE_RETENTION_DAYS,
} from "../pipeline/baseline-derive.js";
import { SEGMENT_PROFILE_WINDOW_DAYS } from "../pipeline/segment-profile.js";

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

  it("deletes in bounded batches, so a large backlog never lands in one statement", async () => {
    const now = Date.now();
    const stale = new Date(now - 40 * 86_400_000);
    for (let i = 0; i < 5; i++) {
      await seedSample(`batch-drop-${i}`, stale);
    }
    await seedSample("batch-keep", new Date(now - 1 * 86_400_000));

    // batchSize 2 over 5 stale rows forces several passes; the loop must keep
    // going until a short batch proves the backlog is drained, and count via the
    // statement's row count rather than materialising ids.
    const { deleted } = await pruneSpeedSamples(sql, { retentionDays: 35, batchSize: 2 });
    expect(deleted).toBe(5);
    const rows = await sql<{ sensor_key: string }[]>`
      SELECT sensor_key FROM conditions.sensor_speed_sample WHERE sensor_key LIKE 'batch-%'`;
    expect(rows.map((r) => r.sensor_key)).toEqual(["batch-keep"]);
  }, 60_000);
});

describe("sample retention vs consumer windows", () => {
  // The prune and the derivations each carried their own literal, and drifted:
  // the segment-profile derivation read 42 days against a 35-day retention, so
  // days 36-42 were always already pruned and it silently derived from less
  // history than it asked for. Retention must cover every consumer's window.
  it("keeps the retention at least as long as every window that reads the table", () => {
    expect(BASELINE_WINDOW_DAYS).toBeLessThanOrEqual(SPEED_SAMPLE_RETENTION_DAYS);
    expect(SEGMENT_PROFILE_WINDOW_DAYS).toBeLessThanOrEqual(SPEED_SAMPLE_RETENTION_DAYS);
  });
});
