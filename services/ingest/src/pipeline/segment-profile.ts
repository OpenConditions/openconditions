import { histogramPercentileKph, rollupRetentionDaysFromEnv } from "@openconditions/storage";
import type postgres from "postgres";
import { loadOsmRegions, type OsmRegion } from "./osm-import.js";

type Sql = postgres.Sql;

/**
 * Window this derivation reads from the hourly rollup: the rollup's retention.
 * Asking for more days than are kept does not widen the history, it just
 * misdescribes it — the extra days were pruned before this ever runs.
 */
export const SEGMENT_PROFILE_WINDOW_DAYS = rollupRetentionDaysFromEnv().hourly;

export interface DeriveSegmentProfilesOpts {
  windowDays?: number;
  minSamples?: number;
}

/**
 * Builds `CASE r.region WHEN <id> THEN <tz> ... END` as a parameterized
 * nested fragment (postgres.js merges nested `sql\`\`` templates into the
 * outer query's placeholders — see the "Building queries" section of the
 * postgres.js README) rather than string concatenation, so `region.id`/
 * `region.tz` never touch raw SQL text even though they come from trusted
 * config. The caller skips derivation when no regions are configured.
 */
function regionTzCase(sql: Sql, regions: OsmRegion[]) {
  return regions.reduce((acc, r) => sql`${acc} WHEN ${r.id} THEN ${r.tz}`, sql``);
}

/**
 * Derives per-(segment, weekday, hour) typical-speed profiles from the rolling
 * hourly `traffic.speed` rollup, mirroring `baseline-derive.ts`'s
 * percentile/upsert shape but grouped by segment (via `sensor_segment` ->
 * `road_segment` -> `osm_road`) and bucketed in the segment's
 * REGION-LOCAL time — NOT the rollup's UTC `hour_utc`. Valhalla evaluates
 * predicted-traffic buckets in the edge's local timezone with the week starting
 * Sunday 00:00 local, so a UTC-bucketed profile would shift NL/FI/SE/US-NY rush
 * hours by 1-3 hours (see plan 12's Time semantics note).
 *
 * Each bucket records the distinct sources whose readings fed its median
 * (`contributing`, the rollup series' source ids), so the public export can
 * withhold a profile a restricted source helped shape.
 *
 * The median comes off each hour's merged histogram rather than a sort over raw
 * readings — raw speed history only keeps a few days, so this window exists
 * solely in the rollup.
 *
 * Bucketing whole UTC hours into local time is exact for every whole-hour zone,
 * such as Europe/Amsterdam. A HALF-hour zone (e.g.
 * Newfoundland, India) would put one UTC hour across two local hours; the rollup
 * assigns it wholly to the local hour its start falls in, where per-sample
 * bucketing would have split it. Revisit the rollup grain before adding one.
 *
 * The region -> tz mapping is generated from `loadOsmRegions()` at call
 * time (single source of truth = config, not a hand-maintained SQL CASE); a
 * region with no valid `tz` is simply absent from the CASE, so its rows are
 * dropped by the `tzmap.tz IS NOT NULL` guard rather than failing the whole
 * run.
 */
export async function deriveSegmentProfiles(
  sql: Sql,
  now: () => string,
  opts: DeriveSegmentProfilesOpts = {},
): Promise<{ upserted: number }> {
  const windowDays = opts.windowDays ?? SEGMENT_PROFILE_WINDOW_DAYS;
  const minSamples = opts.minSamples ?? 20;
  const regions = loadOsmRegions(process.env);
  if (regions.length === 0) return { upserted: 0 };
  const tzCase = regionTzCase(sql, regions);
  const median = histogramPercentileKph(sql, 0.5);

  const rows = await sql<{ segment_id: string }[]>`
    WITH win AS (
      SELECT ss.segment_id, l.source_id,
             extract(dow  from h.hour_utc AT TIME ZONE tzmap.tz)::smallint AS local_dow,
             extract(hour from h.hour_utc AT TIME ZONE tzmap.tz)::smallint AS local_hour,
             u.bin, u.cnt
      FROM conditions.observation_rollup_hourly h
      JOIN conditions.observation_latest l ON l.series_id = h.series_id
        AND l.property = 'traffic.speed' AND l.component_key IS NULL
      JOIN conditions.sensor_segment ss ON ss.subject_key = l.subject_key
      JOIN conditions.road_segment rs ON rs.segment_id = ss.segment_id
      JOIN conditions.osm_road r ON r.way_id = rs.way_id
      CROSS JOIN LATERAL (SELECT CASE r.region${tzCase} END AS tz) tzmap
      CROSS JOIN LATERAL unnest(h.bins, h.counts) AS u(bin, cnt)
      WHERE h.hour_utc >= now() - make_interval(days => ${windowDays})
        AND tzmap.tz IS NOT NULL
    ),
    binned AS (
      SELECT segment_id, local_dow, local_hour, bin, sum(cnt)::bigint AS c,
             array_agg(DISTINCT source_id) AS srcs
      FROM win GROUP BY 1, 2, 3, 4
    ),
    cum AS (
      SELECT segment_id, local_dow, local_hour, bin, srcs,
             sum(c) OVER (PARTITION BY segment_id, local_dow, local_hour ORDER BY bin
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_c,
             sum(c) OVER (PARTITION BY segment_id, local_dow, local_hour) AS total
      FROM binned
    )
    INSERT INTO conditions.segment_profile
      (segment_id, dow, tod_hour, speed_kph, sample_count, contributing, computed_at)
    SELECT segment_id, local_dow, local_hour, ${median}, max(total)::int,
           (SELECT array_agg(DISTINCT s ORDER BY s)
              FROM jsonb_array_elements_text(
                     jsonb_path_query_array(jsonb_agg(srcs), '$[*][*]')) s),
           ${now()}
    FROM cum
    GROUP BY segment_id, local_dow, local_hour
    HAVING max(total) >= ${minSamples}
    ON CONFLICT (segment_id, dow, tod_hour) DO UPDATE SET
      speed_kph = EXCLUDED.speed_kph, sample_count = EXCLUDED.sample_count,
      contributing = EXCLUDED.contributing, computed_at = EXCLUDED.computed_at
    RETURNING segment_id`;

  return { upserted: rows.length };
}
