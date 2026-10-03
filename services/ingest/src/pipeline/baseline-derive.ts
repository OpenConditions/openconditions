import { histogramPercentileKph } from "@openconditions/storage";
import type postgres from "postgres";

type Sql = postgres.Sql;

/**
 * Window deriveBaselines reads. MUST be <= the hourly rollup's retention (35
 * days by default) — the rollup is the only history there is, so asking for
 * more days than are kept does not widen the window, it just misdescribes it.
 */
export const BASELINE_WINDOW_DAYS = 28;

/**
 * Recomputes derived free-flow baselines of measurement sites from the hourly
 * `traffic.speed` rollup. Writes a specific-bucket row per populated (site,
 * weekday/weekend, hour) meeting minSamples, plus a per-site overall (-1,-1)
 * row, keyed by the subject key of the site's speed series. Buckets are UTC
 * (dow 0/6 = weekend). TODO: local-timezone bucketing is a future refinement.
 *
 * Reads the hourly rollup, not the raw readings: raw speed history keeps only
 * a few days, so the 28-day window exists solely in the rollup. Each row
 * carries its hour's speed distribution as a sparse histogram, so a bucket is
 * merged by summing counts per bin and the p85 read off the cumulative
 * distribution. Bin 0 (below 2 km/h) is left out: standstills are kept as
 * data, but a queue's zeros are not a free-flow speed and must not drag the
 * p85 down nor make up the sample count.
 */
export async function deriveBaselines(
  sql: Sql,
  opts: { windowDays?: number; minSamples?: number } = {},
): Promise<{ upserted: number }> {
  const windowDays = opts.windowDays ?? BASELINE_WINDOW_DAYS;
  const minSamples = opts.minSamples ?? 30;
  const p85 = histogramPercentileKph(sql, 0.85);
  const speeds = sql`
    SELECT l.subject_key, l.source_id AS source, h.hour_utc, u.bin, u.cnt
    FROM conditions.observation_rollup_hourly h
    JOIN conditions.observation_latest l ON l.series_id = h.series_id
    CROSS JOIN LATERAL unnest(h.bins, h.counts) AS u(bin, cnt)
    WHERE l.property = 'traffic.speed' AND l.component_key IS NULL
      AND h.hour_utc >= now() - make_interval(days => ${windowDays})
      AND u.bin > 0`;

  // These specific-bucket rows are NOT read by loadBaselineMap (baseline-store.ts) —
  // it resolves free-flow from the overall (-1,-1) row only. They are kept here
  // for a future typical-speed-per-bucket feature, not dead: do not remove this
  // INSERT to "clean up" loadBaselineMap's fix.
  const specific = await sql<{ subject_key: string }[]>`
    WITH win AS (
      SELECT s.subject_key, s.source,
             (CASE WHEN extract(dow from s.hour_utc) IN (0, 6) THEN 1 ELSE 0 END)::smallint AS dow_bucket,
             extract(hour from s.hour_utc)::smallint AS tod_bucket,
             s.bin, s.cnt
      FROM (${speeds}) s
    ),
    binned AS (
      SELECT subject_key, dow_bucket, tod_bucket, bin,
             sum(cnt)::bigint AS c, min(source) AS source
      FROM win GROUP BY 1, 2, 3, 4
    ),
    cum AS (
      SELECT subject_key, dow_bucket, tod_bucket, bin, source,
             sum(c) OVER (PARTITION BY subject_key, dow_bucket, tod_bucket ORDER BY bin
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_c,
             sum(c) OVER (PARTITION BY subject_key, dow_bucket, tod_bucket) AS total
      FROM binned
    )
    INSERT INTO conditions.sensor_baseline
      (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
    SELECT subject_key, min(source), dow_bucket, tod_bucket, ${p85},
      'derived', max(total)::int, now()
    FROM cum
    GROUP BY subject_key, dow_bucket, tod_bucket
    HAVING max(total) >= ${minSamples}
    ON CONFLICT (subject_key, dow_bucket, tod_bucket, method)
    DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, source = EXCLUDED.source,
      sample_count = EXCLUDED.sample_count, computed_at = EXCLUDED.computed_at
    RETURNING subject_key`;

  const overall = await sql<{ subject_key: string }[]>`
    WITH binned AS (
      SELECT subject_key, bin, sum(cnt)::bigint AS c, min(source) AS source
      FROM (${speeds}) s GROUP BY 1, 2
    ),
    cum AS (
      SELECT subject_key, bin, source,
             sum(c) OVER (PARTITION BY subject_key ORDER BY bin
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_c,
             sum(c) OVER (PARTITION BY subject_key) AS total
      FROM binned
    )
    INSERT INTO conditions.sensor_baseline
      (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
    SELECT subject_key, min(source), -1, -1, ${p85},
      'derived', max(total)::int, now()
    FROM cum
    GROUP BY subject_key
    HAVING max(total) >= ${minSamples}
    ON CONFLICT (subject_key, dow_bucket, tod_bucket, method)
    DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, source = EXCLUDED.source,
      sample_count = EXCLUDED.sample_count, computed_at = EXCLUDED.computed_at
    RETURNING subject_key`;

  return { upserted: specific.length + overall.length };
}
