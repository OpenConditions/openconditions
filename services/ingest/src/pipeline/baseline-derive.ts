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
  const rows = await sql<{ subject_key: string }[]>`
    WITH hours AS (
      SELECT l.subject_key,l.source_id AS source,h.bins,h.counts,h.contributor_receipt_ids,
        (CASE WHEN extract(dow from h.hour_utc) IN (0,6) THEN 1 ELSE 0 END)::smallint AS dow_bucket,
        extract(hour from h.hour_utc)::smallint AS tod_bucket,
        conditions.flow_receipt_permissions(h.contributor_receipt_ids,h.lineage_complete,${CONTRIBUTOR_RECEIPT_VERSION}) AS permission_licenses
      FROM conditions.observation_rollup_hourly h
      JOIN conditions.observation_latest l ON l.series_id=h.series_id
      WHERE l.property='traffic.speed' AND l.component_key IS NULL
        AND h.hour_utc >= now()-make_interval(days=>${windowDays})
        AND EXISTS(SELECT 1 FROM unnest(h.bins) bin WHERE bin>0)
    ), lineage AS (
      SELECT subject_key,
        CASE WHEN GROUPING(dow_bucket)=1 THEN -1 ELSE dow_bucket END AS dow_bucket,
        CASE WHEN GROUPING(tod_bucket)=1 THEN -1 ELSE tod_bucket END AS tod_bucket,
        min(source) AS source,array_agg(DISTINCT source ORDER BY source) AS contributing,
        conditions.flow_permission_union(jsonb_agg(to_jsonb(permission_licenses))) AS permission_licenses,
        bool_and(permission_licenses IS NOT NULL) AS complete,
        ARRAY(SELECT DISTINCT id FROM jsonb_array_elements_text(jsonb_path_query_array(jsonb_agg(contributor_receipt_ids),'$[*][*]')) id ORDER BY id) AS receipt_ids
      FROM hours GROUP BY GROUPING SETS((subject_key,dow_bucket,tod_bucket),(subject_key))
    ), binned AS (
      SELECT subject_key,
        CASE WHEN GROUPING(dow_bucket)=1 THEN -1 ELSE dow_bucket END AS dow_bucket,
        CASE WHEN GROUPING(tod_bucket)=1 THEN -1 ELSE tod_bucket END AS tod_bucket,
        u.bin,sum(u.cnt)::bigint AS c
      FROM hours CROSS JOIN LATERAL unnest(bins,counts) u(bin,cnt) WHERE u.bin>0
      GROUP BY GROUPING SETS((subject_key,dow_bucket,tod_bucket,u.bin),(subject_key,u.bin))
    ), cum AS (
      SELECT *,sum(c) OVER(PARTITION BY subject_key,dow_bucket,tod_bucket ORDER BY bin ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_c,
        sum(c) OVER(PARTITION BY subject_key,dow_bucket,tod_bucket) AS total FROM binned
    ), medians AS (
      SELECT subject_key,dow_bucket,tod_bucket,${p85} AS free_flow_kph,max(total)::int AS sample_count
      FROM cum GROUP BY subject_key,dow_bucket,tod_bucket HAVING max(total)>=${minSamples}
    )
    INSERT INTO conditions.sensor_baseline
      (subject_key,source,dow_bucket,tod_bucket,free_flow_kph,method,sample_count,computed_at,contributor_receipt_ids,lineage_complete,permission_licenses,contributing)
    SELECT m.subject_key,l.source,m.dow_bucket,m.tod_bucket,m.free_flow_kph,'derived',m.sample_count,now(),l.receipt_ids,l.complete,l.permission_licenses,l.contributing
    FROM medians m JOIN lineage l USING(subject_key,dow_bucket,tod_bucket)
    ON CONFLICT(subject_key,dow_bucket,tod_bucket,method) DO UPDATE SET
      free_flow_kph=EXCLUDED.free_flow_kph,source=EXCLUDED.source,sample_count=EXCLUDED.sample_count,computed_at=EXCLUDED.computed_at,
      contributor_receipt_ids=EXCLUDED.contributor_receipt_ids,lineage_complete=EXCLUDED.lineage_complete,
      permission_licenses=EXCLUDED.permission_licenses,contributing=EXCLUDED.contributing
    RETURNING subject_key`;
  return { upserted: rows.length };
}
