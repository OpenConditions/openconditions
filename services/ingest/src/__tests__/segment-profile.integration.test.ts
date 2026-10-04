import { runMigrations } from "@openconditions/core/server";
import { SPEED_BIN_WIDTH_KPH } from "@openconditions/storage";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSegmentProfiles } from "../pipeline/segment-profile.js";
import { seedSpeedHour, siteKey } from "./helpers/flow-series.js";

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
  site: string;
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
    INSERT INTO conditions.sensor_segment (subject_key, segment_id, fraction, offset_m, matched_at)
    VALUES (${siteKey("src", opts.site)}, ${opts.segmentId}, 0.5, 5.0, ${NOW})`;
}

/** One hour of a site's rolled-up speeds; the profiles read the hourly rollup. */
async function seedSpeedSamples(site: string, speeds: number[], base: Date): Promise<void> {
  await seedSpeedHour(sql, "src", site, speeds, base, { type: "Point", coordinates: [5.05, 52.0] });
}

beforeEach(() =>
  vi.stubEnv(
    "SEGMENT_REGIONS",
    JSON.stringify([{ id: "nl", bbox: [3.31, 50.75, 7.09, 53.51], tz: "Europe/Amsterdam" }]),
  ),
);
afterEach(() => vi.unstubAllEnvs());

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
    await seedChain({ wayId: 1, region: "nl", segmentId: "A:f", site: "a" });

    const speeds = [50, 60, 70, 80, 90]; // median 70
    await seedSpeedSamples("a", speeds, SUMMER_UTC_HOUR6);

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

  it("a derived profile records the sources it was built from", async () => {
    await seedChain({ wayId: 4, region: "nl", segmentId: "D:f", site: "d1" });
    await sql`
      INSERT INTO conditions.sensor_segment (subject_key, segment_id, fraction, offset_m, matched_at)
      VALUES (${siteKey("other", "d2")}, 'D:f', 0.5, 5.0, ${NOW})`;
    await seedSpeedSamples("d1", [50, 60, 70], SUMMER_UTC_HOUR6);
    await seedSpeedHour(sql, "other", "d2", [60, 70], SUMMER_UTC_HOUR6, {
      type: "Point",
      coordinates: [5.05, 52.0],
    });
    // A source whose readings sit in another hour contributes only to that hour.
    const otherHour = new Date(SUMMER_UTC_HOUR6.getTime() + 3_600_000);
    await seedSpeedSamples("d1", [50, 60, 70, 80, 90], otherHour);

    await deriveSegmentProfiles(sql, () => "2026-07-08T03:30:00.000Z", {
      windowDays: 3650,
      minSamples: 5,
    });

    const rows = await sql<{ tod_hour: number; contributing: string[] }[]>`
      SELECT tod_hour, contributing FROM conditions.segment_profile
      WHERE segment_id = 'D:f' ORDER BY tod_hour`;
    expect(rows.map((r) => [r.tod_hour, [...r.contributing].sort()])).toEqual([
      [8, ["other", "src"]],
      [9, ["src"]],
    ]);
  }, 60_000);

  it("drops samples for a region absent from the tz CASE via the tzmap.tz IS NOT NULL guard", async () => {
    await seedChain({ wayId: 2, region: "xx-unmapped", segmentId: "B:f", site: "b" });

    const base = utcHour6Base(6);
    await seedSpeedSamples("b", [50, 60, 70, 80, 90], base);

    await deriveSegmentProfiles(sql, () => "2026-07-08T03:30:00.000Z", {
      windowDays: 42,
      minSamples: 5,
    });

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.segment_profile WHERE segment_id = 'B:f'`;
    expect(rows[0]!.n).toBe(0);
  }, 30_000);

  it("skips an in-window bucket seeded below minSamples via the HAVING clause", async () => {
    await seedChain({ wayId: 3, region: "nl", segmentId: "C:f", site: "c" });

    const base = utcHour6Base(5);
    await seedSpeedSamples("c", [70, 72, 74], base); // 3 rows, below minSamples

    await deriveSegmentProfiles(sql, () => "2026-07-08T03:30:00.000Z", {
      windowDays: 42,
      minSamples: 5,
    });

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.segment_profile WHERE segment_id = 'C:f'`;
    expect(rows[0]!.n).toBe(0);
  }, 30_000);
});

it("skips profile SQL when region coverage is not configured", async () => {
  vi.stubEnv("SEGMENT_REGIONS", "");
  const query = vi.fn();
  expect(await deriveSegmentProfiles(query as unknown as postgres.Sql, () => NOW)).toEqual({
    upserted: 0,
  });
  expect(query).not.toHaveBeenCalled();
});
