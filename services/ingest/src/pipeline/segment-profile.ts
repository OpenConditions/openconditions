import type postgres from "postgres";
import { histogramPercentileKph, HOURLY_RETENTION_DAYS } from "./speed-rollup.js";
import { loadOsmRegions, type OsmRegion } from "./osm-import.js";

type Sql = postgres.Sql;

/**
 * Window this derivation reads from the hourly rollup.
 *
 * Capped at the rollup retention: asking for more days than are kept does not
 * widen the history, it just misdescribes it — the extra days were pruned before
 * this ever runs. (It read 42 days against a 35-day retention, so days 36-42
 * were always empty and the profiles were quietly derived from 35.)
 */
export const SEGMENT_PROFILE_WINDOW_DAYS = HOURLY_RETENTION_DAYS;

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
 * config. `loadOsmRegions` never returns an empty list (it falls back to
 * `DEFAULT_OSM_REGIONS`), so this always emits at least one WHEN.
 */
function regionTzCase(sql: Sql, regions: OsmRegion[]) {
  return regions.reduce((acc, r) => sql`${acc} WHEN ${r.id} THEN ${r.tz}`, sql``);
}

/**
 * Derives per-(segment, weekday, hour) typical-speed profiles from the rolling
 * `sensor_speed_hourly` window, mirroring `baseline-derive.ts`'s
 * percentile/upsert shape but grouped by segment (via `sensor_segment` ->
 * `road_segment` -> `osm_road`) and bucketed in the segment's
 * REGION-LOCAL time — NOT the rollup's UTC `hour_utc`. Valhalla evaluates
 * predicted-traffic buckets in the edge's local timezone with the week starting
 * Sunday 00:00 local, so a UTC-bucketed profile would shift NL/FI/SE/US-NY rush
 * hours by 1-3 hours (see plan 12's Time semantics note).
 *
 * The median comes off each hour's merged histogram rather than a sort over raw
 * samples — the raw table only keeps a few days, so this window exists solely in
 * the rollup (see speed-rollup.ts).
 *
 * Bucketing whole UTC hours into local time is exact for every whole-hour zone,
 * which is all of SEGMENT_REGIONS (nl/se/fi/us-ny). A HALF-hour zone (e.g.
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
  opts: DeriveSegmentProfilesOpts = {}
): Promise<{ upserted: number }> {
  const windowDays = opts.windowDays ?? SEGMENT_PROFILE_WINDOW_DAYS;
  const minSamples = opts.minSamples ?? 20;
  const tzCase = regionTzCase(sql, loadOsmRegions(process.env));
  const median = histogramPercentileKph(sql, 0.5);

  const rows = await sql<{ segment_id: string }[]>`
    WITH win AS (
      SELECT ss.segment_id,
             extract(dow  from h.hour_utc AT TIME ZONE tzmap.tz)::smallint AS local_dow,
             extract(hour from h.hour_utc AT TIME ZONE tzmap.tz)::smallint AS local_hour,
             u.bin, u.cnt
      FROM conditions.sensor_speed_hourly h
      JOIN conditions.sensor_segment ss ON ss.sensor_key = h.sensor_key
      JOIN conditions.road_segment rs ON rs.segment_id = ss.segment_id
      JOIN conditions.osm_road r ON r.way_id = rs.way_id
      CROSS JOIN LATERAL (SELECT CASE r.region${tzCase} END AS tz) tzmap
      CROSS JOIN LATERAL unnest(h.speed_bins, h.speed_counts) AS u(bin, cnt)
      WHERE h.hour_utc >= now() - make_interval(days => ${windowDays})
        AND tzmap.tz IS NOT NULL
    ),
    binned AS (
      SELECT segment_id, local_dow, local_hour, bin, sum(cnt)::bigint AS c
      FROM win GROUP BY 1, 2, 3, 4
    ),
    cum AS (
      SELECT segment_id, local_dow, local_hour, bin,
             sum(c) OVER (PARTITION BY segment_id, local_dow, local_hour ORDER BY bin
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_c,
             sum(c) OVER (PARTITION BY segment_id, local_dow, local_hour) AS total
      FROM binned
    )
    INSERT INTO conditions.segment_profile (segment_id, dow, tod_hour, speed_kph, sample_count, computed_at)
    SELECT segment_id, local_dow, local_hour, ${median}, max(total)::int, ${now()}
    FROM cum
    GROUP BY segment_id, local_dow, local_hour
    HAVING max(total) >= ${minSamples}
    ON CONFLICT (segment_id, dow, tod_hour) DO UPDATE SET
      speed_kph = EXCLUDED.speed_kph, sample_count = EXCLUDED.sample_count, computed_at = EXCLUDED.computed_at
    RETURNING segment_id`;

  return { upserted: rows.length };
}
