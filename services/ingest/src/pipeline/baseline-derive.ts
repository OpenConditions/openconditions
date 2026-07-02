import type postgres from "postgres";

type Sql = postgres.Sql;

/**
 * Recomputes derived free-flow baselines from the rolling sample window.
 * percentile_cont(0.85) is evaluated in SQL. Writes a specific-bucket row per
 * populated (sensor_key, weekday/weekend, hour) meeting minSamples, plus a
 * per-sensor overall (-1,-1) row. Buckets are UTC (dow 0/6 = weekend).
 * TODO: local-timezone bucketing is a future refinement.
 */
export async function deriveBaselines(
  sql: Sql,
  opts: { windowDays?: number; minSamples?: number } = {}
): Promise<{ upserted: number }> {
  const windowDays = opts.windowDays ?? 28;
  const minSamples = opts.minSamples ?? 30;

  const specific = await sql<{ sensor_key: string }[]>`
    INSERT INTO conditions.sensor_baseline
      (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
    SELECT sensor_key, min(source),
      CASE WHEN dow IN (0, 6) THEN 1 ELSE 0 END AS dow_bucket,
      tod_hour AS tod_bucket,
      percentile_cont(0.85) WITHIN GROUP (ORDER BY speed_kph) AS free_flow_kph,
      'derived', count(*)::int, now()
    FROM conditions.sensor_speed_sample
    WHERE observed_at >= now() - make_interval(days => ${windowDays})
    GROUP BY sensor_key, CASE WHEN dow IN (0, 6) THEN 1 ELSE 0 END, tod_hour
    HAVING count(*) >= ${minSamples}
    ON CONFLICT (sensor_key, dow_bucket, tod_bucket, method)
    DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, source = EXCLUDED.source,
      sample_count = EXCLUDED.sample_count, computed_at = EXCLUDED.computed_at
    RETURNING sensor_key`;

  const overall = await sql<{ sensor_key: string }[]>`
    INSERT INTO conditions.sensor_baseline
      (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
    SELECT sensor_key, min(source), -1, -1,
      percentile_cont(0.85) WITHIN GROUP (ORDER BY speed_kph) AS free_flow_kph,
      'derived', count(*)::int, now()
    FROM conditions.sensor_speed_sample
    WHERE observed_at >= now() - make_interval(days => ${windowDays})
    GROUP BY sensor_key
    HAVING count(*) >= ${minSamples}
    ON CONFLICT (sensor_key, dow_bucket, tod_bucket, method)
    DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, source = EXCLUDED.source,
      sample_count = EXCLUDED.sample_count, computed_at = EXCLUDED.computed_at
    RETURNING sensor_key`;

  return { upserted: specific.length + overall.length };
}

/**
 * Retention prune of conditions.sensor_speed_sample: deletes rows whose
 * observed_at falls outside the retention window. Independent of atomicSwap;
 * meant to run on a schedule alongside deriveBaselines so the history table
 * does not grow unbounded.
 */
export async function pruneSpeedSamples(
  sql: Sql,
  opts: { retentionDays?: number } = {}
): Promise<{ deleted: number }> {
  const retentionDays = opts.retentionDays ?? 35;
  const rows = await sql<{ id: number }[]>`
    DELETE FROM conditions.sensor_speed_sample
    WHERE observed_at < now() - make_interval(days => ${retentionDays})
    RETURNING id`;
  return { deleted: rows.length };
}
