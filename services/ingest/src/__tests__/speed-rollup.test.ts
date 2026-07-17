import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { BASELINE_WINDOW_DAYS, deriveBaselines } from "../pipeline/baseline-derive.js";
import { SEGMENT_PROFILE_WINDOW_DAYS } from "../pipeline/segment-profile.js";
import {
  binForSpeed,
  HOURLY_RETENTION_DAYS,
  kphForBin,
  pruneHourlyRollup,
  pruneRawSamples,
  rollupSpeedSamples,
  SPEED_BIN_COUNT,
  SPEED_BIN_WIDTH_KPH,
} from "../pipeline/speed-rollup.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

/** Top of an hour N days back — inside every window, and never the open hour. */
function hoursAgo(n: number): Date {
  const d = new Date(Date.now() - n * 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

async function seedSamples(sensorKey: string, speeds: number[], hour: Date): Promise<void> {
  for (let i = 0; i < speeds.length; i++) {
    // Distinct instants inside the same hour (the raw table is unique on
    // (sensor_key, observed_at)); 40 rows * 60s stays within the hour.
    const observedAt = new Date(hour.getTime() + i * 60_000);
    await sql`
      INSERT INTO conditions.sensor_speed_sample
        (sensor_key, source, observed_at, speed_kph, dow, tod_hour, geom)
      VALUES (${sensorKey}, 'src', ${observedAt}, ${speeds[i]},
        ${observedAt.getUTCDay()}, ${observedAt.getUTCHours()},
        ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[4.9,52.4]}'), 4326))`;
  }
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

describe("bin mapping", () => {
  it("maps a speed to its bin and back to the bin midpoint", () => {
    expect(binForSpeed(0)).toBe(0);
    expect(binForSpeed(1.9)).toBe(0);
    expect(binForSpeed(2)).toBe(1);
    expect(binForSpeed(93)).toBe(46);
    expect(kphForBin(46)).toBe(93);
    // The midpoint is never more than half a bin from any speed in that bin.
    for (const kph of [0.5, 37.2, 93.4, 180.9]) {
      expect(Math.abs(kphForBin(binForSpeed(kph)) - kph)).toBeLessThanOrEqual(
        SPEED_BIN_WIDTH_KPH / 2
      );
    }
  });

  it("clamps out-of-range speeds into the end bins instead of dropping them", () => {
    // A bad reading should skew an estimate slightly, never silently vanish from
    // the sample count.
    expect(binForSpeed(-5)).toBe(0);
    expect(binForSpeed(1e6)).toBe(SPEED_BIN_COUNT - 1);
    expect(binForSpeed(Number.NaN)).toBe(0);
  });
});

describe("rollupSpeedSamples", () => {
  it("collapses an hour of raw samples into one sparse-histogram row", async () => {
    const hour = hoursAgo(5);
    // 4 samples over 3 distinct 2-kph bins: 50,51 -> bin 25; 60 -> 30; 70 -> 35.
    await seedSamples("roll:one", [50, 51, 60, 70], hour);

    const { rows } = await rollupSpeedSamples(sql);
    expect(rows).toBeGreaterThanOrEqual(1);

    const [row] = await sql<
      {
        sample_count: number;
        speed_bins: number[];
        speed_counts: number[];
        source: string;
        lon: number;
      }[]
    >`
      SELECT sample_count, speed_bins, speed_counts, source, ST_X(geom) AS lon
      FROM conditions.sensor_speed_hourly
      WHERE sensor_key = 'roll:one' AND hour_utc = ${hour}`;
    expect(row!.sample_count).toBe(4);
    // Sparse and bin-ascending — only non-empty bins, never 128 slots.
    expect(row!.speed_bins).toEqual([25, 30, 35]);
    expect(row!.speed_counts).toEqual([2, 1, 1]);
    // source/geom are carried so consumers need not read raw for them.
    expect(row!.source).toBe("src");
    expect(row!.lon).toBeCloseTo(4.9, 5);
  }, 60_000);

  it("is idempotent — re-running rewrites the same row rather than doubling counts", async () => {
    const hour = hoursAgo(6);
    await seedSamples("roll:idem", [80, 80, 82], hour);
    await rollupSpeedSamples(sql);
    await rollupSpeedSamples(sql);

    const [row] = await sql<{ sample_count: number; n: number }[]>`
      SELECT sample_count, (SELECT count(*)::int FROM conditions.sensor_speed_hourly
                            WHERE sensor_key = 'roll:idem') AS n
      FROM conditions.sensor_speed_hourly WHERE sensor_key = 'roll:idem'`;
    expect(row!.n).toBe(1);
    expect(row!.sample_count).toBe(3);
  }, 60_000);

  it("never rolls up the still-open current hour", async () => {
    const openHour = new Date();
    openHour.setUTCMinutes(0, 0, 0);
    await seedSamples("roll:open", [90, 91], openHour);
    await rollupSpeedSamples(sql);

    // Aggregating the in-progress hour would freeze a partial distribution that
    // later samples could never correct.
    const rows = await sql`
      SELECT 1 FROM conditions.sensor_speed_hourly WHERE sensor_key = 'roll:open'`;
    expect(rows.length).toBe(0);
  }, 60_000);

  it("does not reach back past the rollup retention, however old the oldest raw row is", async () => {
    await sql`TRUNCATE conditions.sensor_speed_hourly`;
    await sql`TRUNCATE conditions.sensor_speed_sample`;
    // Prod holds 38 rows stamped 2022 from a feed with broken clocks. Anchoring
    // the backfill to the oldest raw row walked the first run through ~1,500
    // empty daily batches — and every hour it produced was past the rollup
    // retention, so the very next prune deleted it again.
    await seedSamples("clamp:ancient", [70], hoursAgo(24 * 365 * 4));
    await seedSamples("clamp:recent", [80, 82], hoursAgo(5));

    const { rows } = await rollupSpeedSamples(sql, { retentionDays: 35 });
    expect(rows).toBe(1);
    const [row] = await sql<{ sensor_key: string }[]>`
      SELECT sensor_key FROM conditions.sensor_speed_hourly`;
    expect(row!.sensor_key).toBe("clamp:recent");
  }, 60_000);

  it("absorbs a late-arriving sample by re-rolling the trailing window", async () => {
    const hour = hoursAgo(2);
    await seedSamples("roll:late", [60, 62], hour);
    await rollupSpeedSamples(sql);

    // The feed publishes one more sample for an hour already rolled up.
    await sql`
      INSERT INTO conditions.sensor_speed_sample
        (sensor_key, source, observed_at, speed_kph, dow, tod_hour, geom)
      VALUES ('roll:late', 'src', ${new Date(hour.getTime() + 30 * 60_000)}, 64,
        0, 0, ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[4.9,52.4]}'), 4326))`;
    await rollupSpeedSamples(sql);

    const [row] = await sql<{ sample_count: number }[]>`
      SELECT sample_count FROM conditions.sensor_speed_hourly
      WHERE sensor_key = 'roll:late' AND hour_utc = ${hour}`;
    expect(row!.sample_count).toBe(3);
  }, 60_000);
});

describe("histogram accuracy against the percentile it replaces", () => {
  // The whole design rests on this: a percentile read off merged histograms must
  // track the percentile_cont over the raw samples it replaced. Uses a bimodal
  // free-flow/congested spread across many hours — the shape a mean+stddev
  // summary could not represent and the reason a distribution is kept.
  it("tracks percentile_cont(0.85) within one bin across a multi-hour window", async () => {
    // Isolated: the rollup advances from its watermark, so seeding history
    // behind one left by an earlier test would not be picked up.
    await sql`TRUNCATE conditions.sensor_speed_hourly`;
    await sql`TRUNCATE conditions.sensor_speed_sample`;
    const sensor = "acc:p85";
    const speeds: number[] = [];
    for (let h = 3; h < 15; h++) {
      const hour = hoursAgo(h * 3);
      const hourly: number[] = [];
      for (let i = 0; i < 40; i++) {
        // ~70% free-flow around 115, ~30% congested around 35.
        const kph = i % 10 < 7 ? 108 + ((i * 7) % 15) : 28 + ((i * 3) % 14);
        hourly.push(kph);
      }
      await seedSamples(sensor, hourly, hour);
      speeds.push(...hourly);
    }
    await rollupSpeedSamples(sql);
    await deriveBaselines(sql, { windowDays: BASELINE_WINDOW_DAYS, minSamples: 30 });

    const [exact] = await sql<{ p85: number }[]>`
      SELECT percentile_cont(0.85) WITHIN GROUP (ORDER BY speed_kph) AS p85
      FROM conditions.sensor_speed_sample WHERE sensor_key = ${sensor}`;
    const [derived] = await sql<{ free_flow_kph: number; sample_count: number }[]>`
      SELECT free_flow_kph, sample_count FROM conditions.sensor_baseline
      WHERE sensor_key = ${sensor} AND dow_bucket = -1 AND tod_bucket = -1 AND method = 'derived'`;

    // Every sample is accounted for — the histogram loses resolution, not data.
    expect(derived!.sample_count).toBe(speeds.length);
    expect(Math.abs(derived!.free_flow_kph - exact!.p85)).toBeLessThanOrEqual(SPEED_BIN_WIDTH_KPH);
  }, 120_000);
});

describe("pruneRawSamples — never outruns the rollup", () => {
  it("deletes nothing while the rollup is empty, however old the samples are", async () => {
    await sql`TRUNCATE conditions.sensor_speed_hourly`;
    await seedSamples("prune:norollup", [70, 71], hoursAgo(24 * 30));

    // Deleting here would discard samples no aggregate ever saw. Disk is
    // recoverable; the history is not.
    const { deleted } = await pruneRawSamples(sql, { retentionDays: 3 });
    expect(deleted).toBe(0);
    const rows = await sql`
      SELECT 1 FROM conditions.sensor_speed_sample WHERE sensor_key = 'prune:norollup'`;
    expect(rows.length).toBe(2);
  }, 60_000);

  it("keeps an un-aggregated sample stamped BEHIND the rollup watermark", async () => {
    await sql`TRUNCATE conditions.sensor_speed_hourly`;
    await sql`TRUNCATE conditions.sensor_speed_sample`;
    // A current sample establishes a watermark...
    await seedSamples("prune:wm", [90], hoursAgo(2));
    await rollupSpeedSamples(sql);
    // ...then a feed republishes history from well before it. The rollup only
    // moves forward, so this hour was never aggregated. A watermark-based prune
    // would delete it (it IS before the watermark) and lose it silently.
    await seedSamples("prune:backfill", [70, 71], hoursAgo(24 * 9));

    const { deleted } = await pruneRawSamples(sql, { retentionDays: 3 });
    expect(deleted).toBe(0);
    const left = await sql`
      SELECT 1 FROM conditions.sensor_speed_sample WHERE sensor_key = 'prune:backfill'`;
    expect(left.length).toBe(2);
  }, 60_000);

  it("deletes past-retention samples only once the rollup has passed them", async () => {
    await sql`TRUNCATE conditions.sensor_speed_hourly`;
    await sql`TRUNCATE conditions.sensor_speed_sample`;
    const old = hoursAgo(24 * 10); // past a 3-day retention
    const recent = hoursAgo(2); // inside it
    await seedSamples("prune:old", [70, 71], old);
    await seedSamples("prune:recent", [80, 81], recent);
    await rollupSpeedSamples(sql); // watermark now covers both

    const { deleted } = await pruneRawSamples(sql, { retentionDays: 3 });
    expect(deleted).toBe(2);
    const left = await sql<{ sensor_key: string }[]>`
      SELECT DISTINCT sensor_key FROM conditions.sensor_speed_sample ORDER BY sensor_key`;
    expect(left.map((r) => r.sensor_key)).toEqual(["prune:recent"]);
    // The rolled-up history of the deleted samples survives them.
    const kept = await sql`
      SELECT 1 FROM conditions.sensor_speed_hourly WHERE sensor_key = 'prune:old'`;
    expect(kept.length).toBe(1);
  }, 60_000);

  it("drops raw older than the ROLLUP retention without waiting for a bucket that will never exist", async () => {
    await sql`TRUNCATE conditions.sensor_speed_hourly`;
    await sql`TRUNCATE conditions.sensor_speed_sample`;
    // The rollup deliberately never reaches this far back, so demanding its
    // bucket would keep the row forever. Nothing can read it either — it is past
    // every consumer's window.
    await seedSamples("prune:ancient", [70], hoursAgo(24 * 365 * 4));

    const { deleted } = await pruneRawSamples(sql, { retentionDays: 3, hourlyRetentionDays: 35 });
    expect(deleted).toBe(1);
    const rows = await sql`SELECT 1 FROM conditions.sensor_speed_sample`;
    expect(rows.length).toBe(0);
  }, 60_000);

  it("deletes in bounded batches", async () => {
    await sql`TRUNCATE conditions.sensor_speed_hourly`;
    await sql`TRUNCATE conditions.sensor_speed_sample`;
    await seedSamples("prune:batch", [60, 61, 62, 63, 64], hoursAgo(24 * 9));
    await rollupSpeedSamples(sql);

    const { deleted } = await pruneRawSamples(sql, { retentionDays: 3, batchSize: 2 });
    expect(deleted).toBe(5);
    const rows = await sql`SELECT 1 FROM conditions.sensor_speed_sample`;
    expect(rows.length).toBe(0);
  }, 60_000);
});

describe("pruneHourlyRollup", () => {
  it("drops rollup hours past the retention window", async () => {
    await sql`TRUNCATE conditions.sensor_speed_hourly`;
    await sql`
      INSERT INTO conditions.sensor_speed_hourly
        (sensor_key, hour_utc, source, geom, sample_count, speed_bins, speed_counts)
      VALUES
        ('h:old', ${hoursAgo(24 * 40)}, 'src',
         ST_SetSRID(ST_MakePoint(0, 0), 4326), 1, ARRAY[30]::smallint[], ARRAY[1]),
        ('h:new', ${hoursAgo(24 * 2)}, 'src',
         ST_SetSRID(ST_MakePoint(0, 0), 4326), 1, ARRAY[30]::smallint[], ARRAY[1])`;

    const { deleted } = await pruneHourlyRollup(sql, { retentionDays: 35 });
    expect(deleted).toBe(1);
    const left = await sql<{ sensor_key: string }[]>`
      SELECT sensor_key FROM conditions.sensor_speed_hourly`;
    expect(left.map((r) => r.sensor_key)).toEqual(["h:new"]);
  }, 60_000);
});

describe("rollup retention vs consumer windows", () => {
  // The rollup is now the ONLY history: raw keeps days, so a consumer window
  // longer than the rollup retention silently reads a truncated history.
  it("keeps the rollup at least as long as every window that reads it", () => {
    expect(BASELINE_WINDOW_DAYS).toBeLessThanOrEqual(HOURLY_RETENTION_DAYS);
    expect(SEGMENT_PROFILE_WINDOW_DAYS).toBeLessThanOrEqual(HOURLY_RETENTION_DAYS);
  });
});
