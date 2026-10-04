import { runMigrations } from "@openconditions/core/server";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveOsmMaxspeed } from "../pipeline/osm-maxspeed.js";
import { seedSpeedHour } from "./helpers/flow-series.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

/** The Overpass interpreter the fallback is pointed at. */
const OVERPASS = "http://overpass:80/api/interpreter";

/**
 * A site the fallback can find: a speed series with a rolled-up hour in the
 * last week. A line site is located on the line (`ST_PointOnSurface`).
 */
async function seedSample(site: string, source: string): Promise<string> {
  const hour = new Date(Date.now() - 2 * 3_600_000);
  hour.setUTCMinutes(0, 0, 0);
  return seedSpeedHour(sql, source, site, [70], hour, {
    type: "LineString",
    coordinates: [
      [24.9, 60.2],
      [24.91, 60.2],
    ],
  });
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
  await sql`TRUNCATE conditions.observation_latest CASCADE`;
  delete process.env["OPENCONDITIONS_OSM_MAXSPEED_FALLBACK"];
});

describe("resolveOsmMaxspeed", () => {
  it("upserts an osm_maxspeed overall baseline for a sensor lacking any baseline", async () => {
    const key = await seedSample("1", "src");
    const queries: string[] = [];
    const urls: string[] = [];
    const recording = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      queries.push(String(init?.body));
      return new Response(overpass, { status: 200 });
    }) as unknown as typeof fetch;
    const { updated } = await resolveOsmMaxspeed(sql, {
      fetch: recording,
      now: () => new Date().toISOString(),
      batchCap: 50,
      overpassUrl: OVERPASS,
    });
    expect(updated).toBe(1);
    expect(urls).toEqual([OVERPASS]);
    expect(queries[0]).toMatch(/around:30,60\.2,24\.9\d*\)/);
    const rows = await sql<
      { free_flow_kph: number; method: string; dow_bucket: number; source: string }[]
    >`SELECT free_flow_kph, method, dow_bucket, source FROM conditions.sensor_baseline
       WHERE subject_key = ${key}`;
    expect(rows[0]!.source).toBe("src");
    expect(rows[0]!.method).toBe("osm_maxspeed");
    expect(rows[0]!.dow_bucket).toBe(-1);
    expect(rows[0]!.free_flow_kph).toBe(100);
  }, 60_000);

  it("skips sensors that already have a baseline and never throws on Overpass errors", async () => {
    const key = await seedSample("1", "src");
    await sql`
      INSERT INTO conditions.sensor_baseline
        (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES (${key}, 'src', -1, -1, 100, 'derived', 0, now())
      ON CONFLICT DO NOTHING`;
    const bad = (async () => {
      throw new Error("overpass down");
    }) as unknown as typeof fetch;
    const { updated } = await resolveOsmMaxspeed(sql, {
      fetch: bad,
      now: () => new Date().toISOString(),
      batchCap: 50,
      overpassUrl: OVERPASS,
    });
    expect(updated).toBe(0);
    const rows = await sql<{ method: string }[]>`
      SELECT method FROM conditions.sensor_baseline WHERE subject_key = ${key}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe("derived");
  }, 30_000);

  it("is a no-op when the env gate is disabled", async () => {
    const key = await seedSample("1", "src");
    process.env["OPENCONDITIONS_OSM_MAXSPEED_FALLBACK"] = "false";
    const { updated } = await resolveOsmMaxspeed(sql, {
      fetch: fetchFn,
      now: () => new Date().toISOString(),
      batchCap: 50,
      overpassUrl: OVERPASS,
    });
    expect(updated).toBe(0);
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.sensor_baseline WHERE subject_key = ${key}`;
    expect(rows[0]!.n).toBe(0);
  }, 30_000);

  it("tolerates a per-sensor Overpass failure without aborting the batch", async () => {
    await seedSample("1", "src");
    await seedSample("2", "src");
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
      overpassUrl: OVERPASS,
    });
    expect(updated).toBe(1);
  }, 30_000);
});
