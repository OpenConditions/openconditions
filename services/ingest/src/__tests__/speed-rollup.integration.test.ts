import type { Observation } from "@openconditions/core";
import { writeSpeedSamples } from "../pipeline/baseline-store.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { BASELINE_WINDOW_DAYS, deriveBaselines } from "../pipeline/baseline-derive.js";
import { SEGMENT_PROFILE_WINDOW_DAYS } from "../pipeline/segment-profile.js";
import {
  HOURLY_RETENTION_DAYS,
  SPEED_HISTORY_LOCK,
  pruneHourlyRollup,
  pruneRawSamples,
  rollupSpeedSamples,
  SPEED_BIN_WIDTH_KPH,
} from "../pipeline/speed-rollup.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

describe("persisted histogram bin boundaries", () => {
  it("retains every sample, floors boundaries, and clamps into the documented end bins", async () => {
    const hour = hoursAgo(5);
    await seedSamples("boundary:sql", [-5, 0, 1.9, 2, 93, 255.9, 256, 1e6], hour);
    await rollupSpeedSamples(sql);
    const [row] = await sql<
      { sample_count: number; speed_bins: number[]; speed_counts: number[] }[]
    >`
      SELECT sample_count, speed_bins, speed_counts FROM conditions.sensor_speed_hourly
      WHERE sensor_key = 'boundary:sql' AND hour_utc = ${hour}`;
    expect(row).toMatchObject({
      sample_count: 8,
      speed_bins: [0, 1, 46, 127],
      speed_counts: [3, 1, 1, 3],
    });
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
    await sql`TRUNCATE conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
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
    await sql`TRUNCATE conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
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
    await sql`TRUNCATE conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
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
    await sql`TRUNCATE conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
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
    await sql`TRUNCATE conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
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
    await sql`TRUNCATE conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
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
    await sql`TRUNCATE conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
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
    await sql`TRUNCATE conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
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

describe("speed hour finalization", () => {
  function sample(id: string, at: string, speedKph = 120): Observation {
    return {
      id,
      source: "src",
      sourceFormat: "native",
      domain: "roads",
      kind: "measurement",
      metric: "flow",
      aggregation: "live",
      status: "active",
      speedKph,
      geometry: { type: "Point", coordinates: [4.9, 52.4] },
      origin: { kind: "feed", attribution: { provider: "t", license: "CC-BY-4.0" } },
      dataUpdatedAt: at,
      fetchedAt: at,
      isStale: false,
    } as Observation;
  }

  it("rejects arrivals to pruned hours without changing durable histograms, even with a stalled watermark", async () => {
    await sql`TRUNCATE conditions.sensor_speed_sample, conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
    const hour = hoursAgo(24 * 9);
    await seedSamples("closed", [20, 20], hour);
    await rollupSpeedSamples(sql);
    await pruneRawSamples(sql);
    const late = sample("closed", new Date(hour.getTime() + 120_000).toISOString());
    expect(
      await writeSpeedSamples(
        sql,
        "src",
        [late, { ...late, id: "missing" }],
        () => new Date().toISOString(),
        60
      )
    ).toEqual({ inserted: 0, rejectedLate: 2 });
    // Even a stale admission clock cannot reopen an explicitly finalized hour.
    expect(
      await writeSpeedSamples(
        sql,
        "src",
        [late],
        () => new Date(hour.getTime() + 3_600_000).toISOString(),
        60
      )
    ).toEqual({ inserted: 0, rejectedLate: 1 });
    await rollupSpeedSamples(sql);
    expect(
      await sql`SELECT sample_count, speed_bins, speed_counts, finalized FROM conditions.sensor_speed_hourly WHERE sensor_key = 'closed'`
    ).toEqual([{ sample_count: 2, speed_bins: [10], speed_counts: [2], finalized: true }]);
  });

  it("admits the cutoff hour, rejects the preceding hour, and finalizes complete input after downtime", async () => {
    await sql`TRUNCATE conditions.sensor_speed_sample, conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
    const hour = hoursAgo(6);
    const clock = new Date(hour.getTime() + 6 * 3_600_000 + 30 * 60_000);
    const observations = [
      sample("boundary", hour.toISOString(), 20),
      sample("too-late", new Date(hour.getTime() - 60_000).toISOString()),
    ];
    expect(
      await writeSpeedSamples(sql, "src", observations, () => clock.toISOString(), 60)
    ).toEqual({ inserted: 1, rejectedLate: 1 });
    await rollupSpeedSamples(sql, { now: () => clock });
    const second = sample("boundary", new Date(hour.getTime() + 60_000).toISOString(), 40);
    expect(await writeSpeedSamples(sql, "src", [second], () => clock.toISOString(), 60)).toEqual({
      inserted: 1,
      rejectedLate: 0,
    });
    expect(await writeSpeedSamples(sql, "src", [second], () => clock.toISOString(), 60)).toEqual({
      inserted: 0,
      rejectedLate: 0,
    });
    const later = new Date(clock.getTime() + 5 * 86_400_000);
    // Retention alone cannot remove accepted input before its final recomputation.
    expect((await pruneRawSamples(sql, { now: () => later })).deleted).toBe(0);
    await rollupSpeedSamples(sql, { now: () => later });
    expect(
      await sql`SELECT sample_count, speed_bins, finalized FROM conditions.sensor_speed_hourly WHERE sensor_key = 'boundary'`
    ).toEqual([{ sample_count: 2, speed_bins: [10, 20], finalized: true }]);
    expect((await pruneRawSamples(sql, { now: () => later })).deleted).toBe(2);
    await rollupSpeedSamples(sql, { now: () => later });
    expect(
      (
        await sql`SELECT sample_count FROM conditions.sensor_speed_hourly WHERE sensor_key = 'boundary'`
      )[0]!.sample_count
    ).toBe(2);
  });

  it("keeps the entire raw hour when retention falls partway through it", async () => {
    await sql`TRUNCATE conditions.sensor_speed_sample, conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
    const hour = hoursAgo(72);
    await seedSamples("whole-hour", [20, 40], hour);
    await rollupSpeedSamples(sql);
    const halfway = new Date(hour.getTime() + 72 * 3_600_000 + 30 * 60_000);
    expect((await pruneRawSamples(sql, { now: () => halfway })).deleted).toBe(0);
    expect(
      (await pruneRawSamples(sql, { now: () => new Date(halfway.getTime() + 3_600_000) })).deleted
    ).toBe(2);
  });

  it("evaluates admission after waiting for finalization's lock", async () => {
    await sql`TRUNCATE conditions.sensor_speed_sample, conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
    const hour = hoursAgo(6);
    let clock = new Date(hour.getTime() + 6 * 3_600_000);
    const locked = deferred<void>();
    const release = deferred<void>();
    const holding = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${SPEED_HISTORY_LOCK}, 0))`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const pending = writeSpeedSamples(
      sql,
      "src",
      [sample("race", hour.toISOString())],
      () => clock.toISOString(),
      60
    );
    try {
      await expect
        .poll(async () => {
          const [row] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
          return row!.n;
        })
        .toBeGreaterThan(0);
      clock = new Date(clock.getTime() + 3_600_000);
    } finally {
      release.resolve();
      await holding;
    }
    expect(await pending).toEqual({ inserted: 0, rejectedLate: 1 });
  });

  it("includes an older admission that was uncommitted when rollup started", async () => {
    await sql`TRUNCATE conditions.sensor_speed_sample, conditions.sensor_speed_hourly, conditions.speed_rollup_progress`;
    await seedSamples("already-visible", [40], hoursAgo(8));
    const locked = deferred<void>();
    const release = deferred<void>();
    const admitting = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${SPEED_HISTORY_LOCK}, 0))`;
      await tx`INSERT INTO conditions.sensor_speed_sample
        (sensor_key, source, observed_at, speed_kph, dow, tod_hour, geom)
        VALUES ('in-flight', 'src', ${hoursAgo(9)}, 20, 1, 1, ST_SetSRID(ST_MakePoint(4.9,52.4),4326))`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const rolling = rollupSpeedSamples(sql);
    try {
      await expect
        .poll(async () => {
          const [row] = await sql<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
          return row!.n;
        })
        .toBeGreaterThan(0);
    } finally {
      release.resolve();
      await admitting;
    }
    await rolling;
    expect(
      await sql`SELECT sensor_key, sample_count, finalized FROM conditions.sensor_speed_hourly ORDER BY sensor_key`
    ).toEqual([
      { sensor_key: "already-visible", sample_count: 1, finalized: true },
      { sensor_key: "in-flight", sample_count: 1, finalized: true },
    ]);
  });
});
