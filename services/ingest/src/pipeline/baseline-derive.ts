import { CONTRIBUTOR_RECEIPT_VERSION } from "@openconditions/core";
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
 * How many measurement sites one statement derives. A batch is its own
 * transaction: the 28 days of a thousand sites' hours, about half a million
 * rollup rows, aggregate in memory in a few seconds, so no snapshot is held
 * long enough to stop vacuum from cleaning up the rows the polls replace.
 */
export const BASELINE_BATCH_SITES = 1000;

/**
 * Recomputes the derived free-flow baseline of each measurement site from the
 * hourly `traffic.speed` rollup: the 85th percentile of its speeds over the
 * window, as the overall (dow_bucket = -1, tod_bucket = -1) row keyed by the
 * subject key of the site's speed series, when it has at least minSamples.
 * The free flow is read from that row alone (`loadBaselineMap`); typical
 * speeds per weekday and hour are the segment profiles' (`segment-profile.ts`).
 *
 * Reads the hourly rollup, not the raw readings: raw speed history keeps only
 * a few days, so the 28-day window exists solely in the rollup. Each row
 * carries its hour's speed distribution as a sparse histogram, so the hours
 * are merged by summing counts per bin and the p85 read off the cumulative
 * distribution. Bin 0 (below 2 km/h) is left out: standstills are kept as
 * data, but a queue's zeros are not a free-flow speed and must not drag the
 * p85 down nor make up the sample count.
 *
 * The lineage (receipts, licences, contributing sources) is that of the hours
 * with a moving speed. Their receipts' permissions are worked out once per
 * distinct receipt set of a series, not once per hour: the sets are few.
 * Sites are derived {@link BASELINE_BATCH_SITES} at a time.
 */
export async function deriveBaselines(
  sql: Sql,
  opts: { windowDays?: number; minSamples?: number; batchSites?: number } = {},
): Promise<{ upserted: number }> {
  const windowDays = opts.windowDays ?? BASELINE_WINDOW_DAYS;
  const minSamples = opts.minSamples ?? 30;
  const batchSites = opts.batchSites ?? BASELINE_BATCH_SITES;
  const p85 = histogramPercentileKph(sql, 0.85);
  const sites = await sql<{ subject_key: string }[]>`
    SELECT DISTINCT subject_key FROM conditions.observation_latest
     WHERE property = 'traffic.speed' AND component_key IS NULL
     ORDER BY subject_key`;
  let upserted = 0;
  for (let i = 0; i < sites.length; i += batchSites) {
    const keys = sites.slice(i, i + batchSites).map((s) => s.subject_key);
    // The rollup is probed by series through its primary key: joined, a batch
    // of series could be planned as a scan of every site's hours.
    const rows = await sql<{ subject_key: string }[]>`
      WITH series AS MATERIALIZED (
        SELECT series_id, subject_key, source_id AS source FROM conditions.observation_latest
         WHERE subject_key = ANY(${keys}::text[]) AND property = 'traffic.speed'
           AND component_key IS NULL
      ), binned AS (
        SELECT h.series_id, u.bin, sum(u.cnt)::bigint AS c
          FROM conditions.observation_rollup_hourly h
         CROSS JOIN LATERAL unnest(h.bins, h.counts) u(bin, cnt)
         WHERE h.series_id = ANY(ARRAY(SELECT series_id FROM series))
           AND h.hour_utc >= now() - make_interval(days => ${windowDays}) AND u.bin > 0
         GROUP BY h.series_id, u.bin
      ), receipts AS (
        SELECT DISTINCT h.series_id, h.contributor_receipt_ids, h.lineage_complete
          FROM conditions.observation_rollup_hourly h
         WHERE h.series_id = ANY(ARRAY(SELECT series_id FROM series))
           AND h.hour_utc >= now() - make_interval(days => ${windowDays})
           AND EXISTS (SELECT 1 FROM unnest(h.bins) bin WHERE bin > 0)
      ), cum AS (
        SELECT subject_key, bin,
          sum(c) OVER (PARTITION BY subject_key ORDER BY bin
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_c,
          sum(c) OVER (PARTITION BY subject_key) AS total
          FROM (SELECT s.subject_key, b.bin, sum(b.c) AS c
                  FROM binned b JOIN series s USING (series_id)
                 GROUP BY s.subject_key, b.bin) merged
      ), medians AS (
        SELECT subject_key, ${p85} AS free_flow_kph, max(total)::int AS sample_count
          FROM cum GROUP BY subject_key HAVING max(total) >= ${minSamples}
      ), lineage AS (
        SELECT s.subject_key, min(s.source) AS source,
          array_agg(DISTINCT s.source ORDER BY s.source) AS contributing,
          conditions.flow_permission_union(jsonb_agg(to_jsonb(r.permission_licenses)))
            AS permission_licenses,
          bool_and(r.permission_licenses IS NOT NULL) AS complete,
          ARRAY(SELECT DISTINCT id FROM jsonb_array_elements_text(
            jsonb_path_query_array(jsonb_agg(r.contributor_receipt_ids), '$[*][*]')) id
            ORDER BY id) AS receipt_ids
          FROM (SELECT r.*, conditions.flow_receipt_permissions(r.contributor_receipt_ids,
                  r.lineage_complete, ${CONTRIBUTOR_RECEIPT_VERSION}) AS permission_licenses
                  FROM receipts r) r
          JOIN series s USING (series_id)
         GROUP BY s.subject_key
      )
      INSERT INTO conditions.sensor_baseline
        (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count,
         computed_at, contributor_receipt_ids, lineage_complete, permission_licenses, contributing)
      SELECT m.subject_key, l.source, -1, -1, m.free_flow_kph, 'derived', m.sample_count, now(),
        l.receipt_ids, l.complete, l.permission_licenses, l.contributing
        FROM medians m JOIN lineage l USING (subject_key)
      ON CONFLICT (subject_key, dow_bucket, tod_bucket, method) DO UPDATE SET
        free_flow_kph = EXCLUDED.free_flow_kph, source = EXCLUDED.source,
        sample_count = EXCLUDED.sample_count, computed_at = EXCLUDED.computed_at,
        contributor_receipt_ids = EXCLUDED.contributor_receipt_ids,
        lineage_complete = EXCLUDED.lineage_complete,
        permission_licenses = EXCLUDED.permission_licenses, contributing = EXCLUDED.contributing
      RETURNING subject_key`;
    upserted += rows.length;
  }
  return { upserted };
}
