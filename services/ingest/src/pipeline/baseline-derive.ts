import type postgres from "postgres";
import { histogramPercentileKph } from "./speed-rollup.js";

type Sql = postgres.Sql;

/**
 * Window deriveBaselines reads. MUST be <= HOURLY_RETENTION_DAYS — the rollup is
 * the only history there is, so asking for more days than are kept does not
 * widen the window, it just misdescribes it. Pinned by a test.
 */
export const BASELINE_WINDOW_DAYS = 28;

/**
 * Recomputes derived free-flow baselines from the rolling hourly rollup.
 * Writes a specific-bucket row per populated (sensor_key, weekday/weekend, hour)
 * meeting minSamples, plus a per-sensor overall (-1,-1) row. Buckets are UTC
 * (dow 0/6 = weekend). TODO: local-timezone bucketing is a future refinement.
 *
 * Reads `sensor_speed_hourly`, not the raw samples: the raw table only keeps a
 * few days as a landing buffer, so the 28-day window exists solely in the
 * rollup. Each row carries its hour's speed distribution as a sparse histogram,
 * so a bucket is merged by summing counts per bin and the p85 read off the
 * cumulative distribution.
 */
export async function deriveBaselines(
  sql: Sql,
  opts: { windowDays?: number; minSamples?: number } = {}
): Promise<{ upserted: number }> {
  const windowDays = opts.windowDays ?? BASELINE_WINDOW_DAYS;
  const minSamples = opts.minSamples ?? 30;
  const p85 = histogramPercentileKph(sql, 0.85);

  // These specific-bucket rows are NOT read by loadBaselineMap (baseline-store.ts) —
  // it resolves free-flow from the overall (-1,-1) row only. They are kept here
  // for a future typical-speed-per-bucket feature (plan 12 segment_profile), not
  // dead: do not remove this INSERT to "clean up" loadBaselineMap's fix.
  const specific = await sql<{ sensor_key: string }[]>`
    WITH win AS (
      SELECT h.sensor_key, h.source,
             (CASE WHEN extract(dow from h.hour_utc) IN (0, 6) THEN 1 ELSE 0 END)::smallint AS dow_bucket,
             extract(hour from h.hour_utc)::smallint AS tod_bucket,
             u.bin, u.cnt
      FROM conditions.sensor_speed_hourly h,
           unnest(h.speed_bins, h.speed_counts) AS u(bin, cnt)
      WHERE h.hour_utc >= now() - make_interval(days => ${windowDays})
    ),
    binned AS (
      SELECT sensor_key, dow_bucket, tod_bucket, bin,
             sum(cnt)::bigint AS c, min(source) AS source
      FROM win GROUP BY 1, 2, 3, 4
    ),
    cum AS (
      SELECT sensor_key, dow_bucket, tod_bucket, bin, source,
             sum(c) OVER (PARTITION BY sensor_key, dow_bucket, tod_bucket ORDER BY bin
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_c,
             sum(c) OVER (PARTITION BY sensor_key, dow_bucket, tod_bucket) AS total
      FROM binned
    )
    INSERT INTO conditions.sensor_baseline
      (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
    SELECT sensor_key, min(source), dow_bucket, tod_bucket, ${p85},
      'derived', max(total)::int, now()
    FROM cum
    GROUP BY sensor_key, dow_bucket, tod_bucket
    HAVING max(total) >= ${minSamples}
    ON CONFLICT (sensor_key, dow_bucket, tod_bucket, method)
    DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, source = EXCLUDED.source,
      sample_count = EXCLUDED.sample_count, computed_at = EXCLUDED.computed_at
    RETURNING sensor_key`;

  const overall = await sql<{ sensor_key: string }[]>`
    WITH win AS (
      SELECT h.sensor_key, h.source, u.bin, u.cnt
      FROM conditions.sensor_speed_hourly h,
           unnest(h.speed_bins, h.speed_counts) AS u(bin, cnt)
      WHERE h.hour_utc >= now() - make_interval(days => ${windowDays})
    ),
    binned AS (
      SELECT sensor_key, bin, sum(cnt)::bigint AS c, min(source) AS source
      FROM win GROUP BY 1, 2
    ),
    cum AS (
      SELECT sensor_key, bin, source,
             sum(c) OVER (PARTITION BY sensor_key ORDER BY bin
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_c,
             sum(c) OVER (PARTITION BY sensor_key) AS total
      FROM binned
    )
    INSERT INTO conditions.sensor_baseline
      (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
    SELECT sensor_key, min(source), -1, -1, ${p85},
      'derived', max(total)::int, now()
    FROM cum
    GROUP BY sensor_key
    HAVING max(total) >= ${minSamples}
    ON CONFLICT (sensor_key, dow_bucket, tod_bucket, method)
    DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, source = EXCLUDED.source,
      sample_count = EXCLUDED.sample_count, computed_at = EXCLUDED.computed_at
    RETURNING sensor_key`;

  return { upserted: specific.length + overall.length };
}
