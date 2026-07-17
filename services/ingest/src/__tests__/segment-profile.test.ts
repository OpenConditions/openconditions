import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { deriveSegmentProfiles } from "../pipeline/segment-profile.js";
import { rollupSpeedSamples, SPEED_BIN_WIDTH_KPH } from "../pipeline/speed-rollup.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";

// A FIXED summer instant (not derived from Date.now()): 2024-07-01T06:00:00Z is
// 08:00 CEST in Europe/Amsterdam (UTC+2 in summer) and 2024-07-01 is a Monday
// (dow 1). Pinned so the UTC->local AT TIME ZONE assertion is deterministic
// year-round — a Date.now()-relative seed would land outside DST (~late Oct-late
// Mar), where the same UTC hour maps to local hour 7 and the test would flap.
const SUMMER_UTC_HOUR6 = new Date("2024-07-01T06:00:00.000Z");

function utcHour6Base(daysAgo: number): Date {
  const base = new Date(Date.now() - daysAgo * 86_400_000);
  base.setUTCHours(6, 0, 0, 0);
  return base;
}

async function seedChain(opts: {
  wayId: number;
  region: string;
  segmentId: string;
  sensorKey: string;
}): Promise<void> {
  await sql`
    INSERT INTO conditions.osm_road (way_id, geom, highway, oneway, region, imported_at)
    VALUES (${opts.wayId}, ST_SetSRID(ST_GeomFromText('LINESTRING(5.0 52.0, 5.1 52.0)'), 4326),
      'motorway', true, ${opts.region}, ${NOW})`;
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${opts.segmentId}, ${opts.wayId}, 'f',
      ST_SetSRID(ST_GeomFromText('LINESTRING(5.0 52.0, 5.1 52.0)'), 4326),
      'motorway', 8000, 5, 120, ${NOW})`;
  await sql`
    INSERT INTO conditions.sensor_segment (sensor_key, segment_id, fraction, offset_m, matched_at)
    VALUES (${opts.sensorKey}, ${opts.segmentId}, 0.5, 5.0, ${NOW})`;
}

async function seedSpeedSamples(sensorKey: string, speeds: number[], base: Date): Promise<void> {
  for (let i = 0; i < speeds.length; i++) {
    const observedAt = new Date(base.getTime() + i * 1000); // distinct instant, same UTC/local hour
    await sql`
      INSERT INTO conditions.sensor_speed_sample
        (sensor_key, source, observed_at, speed_kph, dow, tod_hour, geom)
      VALUES (${sensorKey}, 'src', ${observedAt}, ${speeds[i]},
        ${observedAt.getUTCDay()}, ${observedAt.getUTCHours()},
        ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[5.05,52.0]}'), 4326))`;
  }
  // The profiles read the hourly rollup, not the raw samples. These fixtures sit
  // at a pinned instant years back (the local-hour assertions need a known DST
  // offset), so the rollup — which by default refuses to reach past its own
  // retention — is told to cover them, matching the widened windowDays below.
  await rollupSpeedSamples(sql, { retentionDays: 3650 });
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

describe("deriveSegmentProfiles", () => {
  it("buckets by REGION-LOCAL hour, not the UTC instant (rush-hour offset regression)", async () => {
    await seedChain({ wayId: 1, region: "nl", segmentId: "A:f", sensorKey: "nl:a" });

    const speeds = [50, 60, 70, 80, 90]; // median 70
    await seedSpeedSamples("nl:a", speeds, SUMMER_UTC_HOUR6);

    // The pinned instant is ~2 years before now(); widen the window so it stays
    // inside the rolling window regardless of the wall clock.
    const { upserted } = await deriveSegmentProfiles(sql, () => "2026-07-08T03:30:00.000Z", {
      windowDays: 3650,
      minSamples: 5,
    });
    expect(upserted).toBe(1);

    const rows = await sql<
      { dow: number; tod_hour: number; speed_kph: number; sample_count: number }[]
    >`
      SELECT dow, tod_hour, speed_kph, sample_count
      FROM conditions.segment_profile WHERE segment_id = 'A:f'`;
    expect(rows).toHaveLength(1);
    // LOCAL hour 8 (Europe/Amsterdam, CEST), not the UTC instant's hour 6.
    expect(rows[0]!.tod_hour).toBe(8);
    // 2024-07-01 is a Monday -> local dow 1 (Valhalla's Sunday-first convention).
    expect(rows[0]!.dow).toBe(1);
    // Median 70; the histogram resolves to the containing bin's midpoint, so it
    // lands within one bin rather than exactly on the sample.
    expect(Math.abs(rows[0]!.speed_kph - 70)).toBeLessThanOrEqual(SPEED_BIN_WIDTH_KPH);
    expect(rows[0]!.sample_count).toBe(5);
  }, 60_000);

  it("drops samples for a region absent from the tz CASE via the tzmap.tz IS NOT NULL guard", async () => {
    await seedChain({ wayId: 2, region: "xx-unmapped", segmentId: "B:f", sensorKey: "xx:b" });

    const base = utcHour6Base(6);
    await seedSpeedSamples("xx:b", [50, 60, 70, 80, 90], base);

    await deriveSegmentProfiles(sql, () => "2026-07-08T03:30:00.000Z", {
      windowDays: 42,
      minSamples: 5,
    });

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.segment_profile WHERE segment_id = 'B:f'`;
    expect(rows[0]!.n).toBe(0);
  }, 30_000);

  it("skips an in-window bucket seeded below minSamples via the HAVING clause", async () => {
    await seedChain({ wayId: 3, region: "nl", segmentId: "C:f", sensorKey: "nl:c" });

    const base = utcHour6Base(5);
    await seedSpeedSamples("nl:c", [70, 72, 74], base); // 3 rows, below minSamples

    await deriveSegmentProfiles(sql, () => "2026-07-08T03:30:00.000Z", {
      windowDays: 42,
      minSamples: 5,
    });

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.segment_profile WHERE segment_id = 'C:f'`;
    expect(rows[0]!.n).toBe(0);
  }, 30_000);
});
