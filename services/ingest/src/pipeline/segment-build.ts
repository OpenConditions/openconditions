import type postgres from "postgres";

type Sql = postgres.Sql;

export interface BuildSegmentsOptions {
  /** Build only this region's segments. Omit to loop every distinct `osm_road.region` (the weekly job). */
  region?: string;
}

export interface BuildSegmentsResult {
  /** Rows inserted or upserted across every region built by this call. */
  built: number;
}

/**
 * Rebuilds one region's `road_segment` rows from `osm_road`: scoped DELETE
 * (removes segments for ways this region no longer has) followed by the
 * directed INSERT, wrapped in one transaction so a region is never left
 * half-rebuilt. `ON CONFLICT (segment_id) DO UPDATE` keeps `segment_id`
 * stable across rebuilds — required for a border way that gets rebuilt from
 * an overlapping region, and so a downstream OpenLR encoder can re-encode
 * only the rows whose geometry actually changed.
 */
async function buildRegion(sql: Sql, region: string, now: () => string): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`
      DELETE FROM conditions.road_segment s USING conditions.osm_road r
      WHERE r.way_id = s.way_id AND r.region = ${region}`;

    const rows = await tx`
      INSERT INTO conditions.road_segment
        (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
      SELECT r.way_id || ':' || d.dir,
             r.way_id, d.dir,
             CASE WHEN d.dir = 'f' THEN r.geom ELSE ST_Reverse(r.geom) END,
             r.highway, r.ref, ST_Length(r.geom::geography),
             CASE r.highway
               WHEN 'motorway' THEN 5 WHEN 'trunk' THEN 7 WHEN 'primary' THEN 9
               WHEN 'motorway_link' THEN 10 WHEN 'trunk_link' THEN 10 WHEN 'primary_link' THEN 10
               ELSE 11
             END,
             r.maxspeed_kph, ${now()}
      FROM conditions.osm_road r
      -- Known limitation: this only ever emits 'f' for a oneway way (node-order
      -- geometry), never 'b'. An OSM oneway=-1 way is digitized against its
      -- direction of travel (carried upstream as OsmWay.onewayReversed), so it
      -- should build as a reversed ':b' segment instead — but osm_road has no
      -- orientation column yet to read that from. Refining this later means
      -- adding that flag and reading it here; additive, no consumer change
      -- since segment_id stays opaque text.
      CROSS JOIN LATERAL (
        SELECT unnest(CASE WHEN r.oneway THEN ARRAY['f'] ELSE ARRAY['f', 'b'] END) AS dir
      ) d
      WHERE r.region = ${region}
      ON CONFLICT (segment_id) DO UPDATE SET
        geom = excluded.geom,
        highway = excluded.highway,
        ref = excluded.ref,
        length_m = excluded.length_m,
        min_zoom = excluded.min_zoom,
        free_flow_kph = excluded.free_flow_kph,
        computed_at = excluded.computed_at
      RETURNING segment_id`;

    return rows.length;
  });
}

/**
 * Rebuilds `road_segment` from `osm_road`, one region at a time (incremental
 * — at worldwide scale a full-table rebuild is hours of lock/bloat, so this
 * stays proportional to what changed; the weekly job loops regions). After
 * the region(s) are rebuilt, one final orphan sweep removes any segment
 * whose way has vanished from `osm_road` entirely (in every region, not just
 * the one(s) built this call), so a way deleted upstream doesn't leave a
 * stale segment behind indefinitely.
 */
export async function buildSegments(
  sql: Sql,
  now: () => string,
  opts?: BuildSegmentsOptions
): Promise<BuildSegmentsResult> {
  let regions: string[];
  if (opts?.region) {
    regions = [opts.region];
  } else {
    const rows = await sql<{ region: string }[]>`SELECT DISTINCT region FROM conditions.osm_road`;
    regions = rows.map((r) => r.region);
  }

  let built = 0;
  for (const region of regions) {
    built += await buildRegion(sql, region, now);
  }

  await sql`
    DELETE FROM conditions.road_segment s
    WHERE NOT EXISTS (SELECT 1 FROM conditions.osm_road r WHERE r.way_id = s.way_id)`;

  return { built };
}
