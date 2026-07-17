import type postgres from "postgres";

type Sql = postgres.Sql;

/**
 * How long raw rows in conditions.sensor_speed_sample are kept.
 *
 * INVARIANT: this MUST be >= every consumer's read window
 * ({@link BASELINE_WINDOW_DAYS}, SEGMENT_PROFILE_WINDOW_DAYS), or that consumer
 * silently derives from a truncated history — the rows it asks for were already
 * pruned. `pruneSpeedSamples` and the derivations default to these constants so
 * the relationship is stated in one place instead of drifting across three
 * independent literals; the invariant is pinned by a test.
 *
 * It is also the table's cost knob: the table takes ~20M rows/day, so each
 * retained day is roughly 6 GB.
 */
export const SPEED_SAMPLE_RETENTION_DAYS = 35;

/** Window deriveBaselines reads. MUST be <= {@link SPEED_SAMPLE_RETENTION_DAYS}. */
export const BASELINE_WINDOW_DAYS = 28;

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
  const windowDays = opts.windowDays ?? BASELINE_WINDOW_DAYS;
  const minSamples = opts.minSamples ?? 30;

  // These specific-bucket rows are NOT read by loadBaselineMap (baseline-store.ts) —
  // it resolves free-flow from the overall (-1,-1) row only. They are kept here
  // for a future typical-speed-per-bucket feature (plan 12 segment_profile), not
  // dead: do not remove this INSERT to "clean up" loadBaselineMap's fix.
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
 * How many rows one prune statement deletes. The table takes ~20M rows/day, so a
 * single unbounded `DELETE ... RETURNING id` can match hundreds of millions of
 * rows after any gap in the schedule: it would materialise every id in the
 * service's 1.5 GB heap and hold one transaction open across the whole delete.
 * Chunking keeps memory flat and each transaction short.
 */
export const SPEED_SAMPLE_PRUNE_BATCH_SIZE = 50_000;

/**
 * Retention prune of conditions.sensor_speed_sample: deletes rows whose
 * observed_at falls outside the retention window. Independent of atomicSwap;
 * meant to run on a schedule alongside deriveBaselines so the history table
 * does not grow unbounded.
 *
 * `retentionDays` MUST NOT be shorter than the longest window any consumer reads
 * (see BASELINE_WINDOW_DAYS / SEGMENT_PROFILE_WINDOW_DAYS) or those derivations
 * silently see a truncated history.
 *
 * Deletes in bounded chunks rather than one statement — see
 * {@link SPEED_SAMPLE_PRUNE_BATCH_SIZE}. Counting is done with the statement's
 * row count, so no id list is materialised at all.
 */
export async function pruneSpeedSamples(
  sql: Sql,
  opts: { retentionDays?: number; batchSize?: number } = {}
): Promise<{ deleted: number }> {
  const retentionDays = opts.retentionDays ?? SPEED_SAMPLE_RETENTION_DAYS;
  const batchSize = opts.batchSize ?? SPEED_SAMPLE_PRUNE_BATCH_SIZE;
  let deleted = 0;
  for (;;) {
    const result = await sql`
      DELETE FROM conditions.sensor_speed_sample
      WHERE id IN (
        SELECT id FROM conditions.sensor_speed_sample
        WHERE observed_at < now() - make_interval(days => ${retentionDays})
        LIMIT ${batchSize}
      )`;
    const removed = result.count;
    deleted += removed;
    if (removed < batchSize) {
      return { deleted };
    }
  }
}
