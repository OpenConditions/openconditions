import type postgres from "postgres";

type Sql = postgres.Sql;

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
