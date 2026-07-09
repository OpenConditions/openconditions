import type postgres from "postgres";
import { loadOsmRegions, type OsmRegion } from "./osm-import.js";

type Sql = postgres.Sql;

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
 * Derives per-(segment, weekday, hour) typical-speed profiles from the
 * rolling `sensor_speed_sample` window, mirroring `baseline-derive.ts`'s
 * percentile/upsert shape but grouped by segment (via `sensor_segment` ->
 * `road_segment` -> `osm_road`) and bucketed in the segment's
 * REGION-LOCAL time — NOT `sensor_speed_sample`'s stored `dow`/`tod_hour`
 * columns, which are UTC. Valhalla evaluates predicted-traffic buckets in
 * the edge's local timezone with the week starting Sunday 00:00 local, so a
 * UTC-bucketed profile would shift NL/FI/SE/US-NY rush hours by 1-3 hours
 * (see plan 12's Time semantics note).
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
  const windowDays = opts.windowDays ?? 42;
  const minSamples = opts.minSamples ?? 20;
  const tzCase = regionTzCase(sql, loadOsmRegions(process.env));

  const rows = await sql<{ segment_id: string }[]>`
    INSERT INTO conditions.segment_profile (segment_id, dow, tod_hour, speed_kph, sample_count, computed_at)
    SELECT ss.segment_id,
           extract(dow  from s.observed_at AT TIME ZONE tzmap.tz)::smallint,
           extract(hour from s.observed_at AT TIME ZONE tzmap.tz)::smallint,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY s.speed_kph),
           count(*), ${now()}
    FROM conditions.sensor_speed_sample s
    JOIN conditions.sensor_segment ss ON ss.sensor_key = s.sensor_key
    JOIN conditions.road_segment rs ON rs.segment_id = ss.segment_id
    JOIN conditions.osm_road r ON r.way_id = rs.way_id
    CROSS JOIN LATERAL (SELECT CASE r.region${tzCase} END AS tz) tzmap
    WHERE s.observed_at >= now() - make_interval(days => ${windowDays})
      AND tzmap.tz IS NOT NULL
    GROUP BY ss.segment_id, 2, 3
    HAVING count(*) >= ${minSamples}
    ON CONFLICT (segment_id, dow, tod_hour) DO UPDATE SET
      speed_kph = EXCLUDED.speed_kph, sample_count = EXCLUDED.sample_count, computed_at = EXCLUDED.computed_at
    RETURNING segment_id`;

  return { upserted: rows.length };
}
