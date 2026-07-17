import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { resolveOsmMaxspeed } from "../pipeline/osm-maxspeed.js";
import { rollupSpeedSamples } from "../pipeline/speed-rollup.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

/**
 * A sensor the fallback can find. Seeded into a COMPLETED hour and rolled up:
 * resolveOsmMaxspeed reads the hourly rollup (raw is only a landing buffer now),
 * and the rollup never aggregates the still-open current hour.
 */
async function seedSample(sensorKey: string, source: string): Promise<void> {
  await sql`
    INSERT INTO conditions.sensor_speed_sample
      (sensor_key, source, observed_at, speed_kph, dow, tod_hour, geom)
    VALUES (${sensorKey}, ${source}, now() - interval '2 hours', 70, 1, 8,
      ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[24.9,60.2]}'), 4326))`;
  await rollupSpeedSamples(sql);
}

const overpass = JSON.stringify({
  elements: [{ type: "way", tags: { highway: "trunk", maxspeed: "100" } }],
});
const fetchFn = (async () => new Response(overpass, { status: 200 })) as unknown as typeof fetch;

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

afterEach(async () => {
  await sql`DELETE FROM conditions.sensor_baseline`;
  await sql`DELETE FROM conditions.sensor_speed_sample`;
  delete process.env["OPENCONDITIONS_OSM_MAXSPEED_FALLBACK"];
});

describe("resolveOsmMaxspeed", () => {
  it("upserts an osm_maxspeed overall baseline for a sensor lacking any baseline", async () => {
    await seedSample("src:1", "src");
    const { updated } = await resolveOsmMaxspeed(sql, {
      fetch: fetchFn,
      now: () => new Date().toISOString(),
      batchCap: 50,
    });
    expect(updated).toBe(1);
    const rows = await sql<{ free_flow_kph: number; method: string; dow_bucket: number }[]>`
      SELECT free_flow_kph, method, dow_bucket FROM conditions.sensor_baseline WHERE sensor_key = 'src:1'`;
    expect(rows[0]!.method).toBe("osm_maxspeed");
    expect(rows[0]!.dow_bucket).toBe(-1);
    expect(rows[0]!.free_flow_kph).toBe(100);
  }, 60_000);

  it("skips sensors that already have a baseline and never throws on Overpass errors", async () => {
    await seedSample("src:1", "src");
    await sql`
      INSERT INTO conditions.sensor_baseline
        (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('src:1', 'src', -1, -1, 100, 'derived', 0, now())
      ON CONFLICT DO NOTHING`;
    const bad = (async () => {
      throw new Error("overpass down");
    }) as unknown as typeof fetch;
    const { updated } = await resolveOsmMaxspeed(sql, {
      fetch: bad,
      now: () => new Date().toISOString(),
      batchCap: 50,
    });
    expect(updated).toBe(0);
    const rows = await sql<{ method: string }[]>`
      SELECT method FROM conditions.sensor_baseline WHERE sensor_key = 'src:1'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe("derived");
  }, 30_000);

  it("is a no-op when the env gate is disabled", async () => {
    await seedSample("src:1", "src");
    process.env["OPENCONDITIONS_OSM_MAXSPEED_FALLBACK"] = "false";
    const { updated } = await resolveOsmMaxspeed(sql, {
      fetch: fetchFn,
      now: () => new Date().toISOString(),
      batchCap: 50,
    });
    expect(updated).toBe(0);
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.sensor_baseline WHERE sensor_key = 'src:1'`;
    expect(rows[0]!.n).toBe(0);
  }, 30_000);

  it("tolerates a per-sensor Overpass failure without aborting the batch", async () => {
    await seedSample("src:1", "src");
    await seedSample("src:2", "src");
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return new Response(overpass, { status: 200 });
    }) as unknown as typeof fetch;
    const { updated } = await resolveOsmMaxspeed(sql, {
      fetch: flaky,
      now: () => new Date().toISOString(),
      batchCap: 50,
    });
    expect(updated).toBe(1);
  }, 30_000);
});
