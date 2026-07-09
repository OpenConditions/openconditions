import type postgres from "postgres";

type Sql = postgres.Sql;

export interface MatchSensorsOptions {
  /** Max perpendicular sensor→segment offset in meters a snap may accept. */
  maxOffsetM?: number;
}

export interface MatchSensorsResult {
  /** Rows inserted or updated in `sensor_segment` this run. */
  matched: number;
}

/**
 * Snaps every flow-metric `observations` row onto its nearest `road_segment`
 * within `maxOffsetM` (default 35 m) and upserts the binding into
 * `sensor_segment`, keyed by `sensor_key = observations.id`.
 *
 * Two subtleties baked into the SQL:
 * - **`sp` lateral — non-point geometries must be reduced to a snap point
 *   first.** NYC DOT flow rows are `LineString`s, and
 *   `ST_LineLocatePoint(line, geom)` *errors* unless `geom` is a POINT. `sp`
 *   takes the midpoint of a LineString (mirroring a representative-point
 *   reduction) so every geometry type flows through the same path; a future
 *   MultiLineString/collection feed would still need an extra CASE arm (e.g.
 *   `ST_PointOnSurface`) — none exists today.
 * - **`c.segment_id` tie-break — the nearest-distance tie on bidirectional
 *   ways is exact.** A two-way way yields `:f`/`:b` segments with identical
 *   (reversed) geometry, so ordering by distance alone picks one at random
 *   and can flap between runs. The trailing `ORDER BY ..., c.segment_id`
 *   makes the pick deterministic — which side wins is arbitrary but stable;
 *   the (documented, not-yet-built) bearing/carriageway refinement is the
 *   real fix when it matters.
 *
 * The KNN lateral (`c`) shortlists 6 nearby segments via the `<->` index
 * operator on a small bbox around the snap point; the WHERE clause then
 * applies the real geography-based offset gate plus a loose `ref` match
 * against the sensor's free-text `attributes.roads` field (an OSM `ref` with
 * no sensor-side ref, or vice versa, is not disqualifying — only a stated
 * mismatch is).
 */
export async function matchSensors(
  sql: Sql,
  now: () => string,
  opts?: MatchSensorsOptions
): Promise<MatchSensorsResult> {
  const maxOffsetM = opts?.maxOffsetM ?? 35;

  const rows = await sql`
    INSERT INTO conditions.sensor_segment (sensor_key, segment_id, fraction, offset_m, bearing_deg, matched_at)
    SELECT DISTINCT ON (o.id)
      o.id, c.segment_id,
      ST_LineLocatePoint(c.geom, sp.pt),
      ST_Distance(c.geom::geography, sp.pt::geography),
      degrees(ST_Azimuth(
        ST_LineInterpolatePoint(c.geom, GREATEST(ST_LineLocatePoint(c.geom, sp.pt) - 0.001, 0)),
        ST_LineInterpolatePoint(c.geom, LEAST(ST_LineLocatePoint(c.geom, sp.pt) + 0.001, 1)))),
      ${now()}
    FROM conditions.observations o
    CROSS JOIN LATERAL (
      SELECT CASE WHEN GeometryType(o.geom) = 'POINT' THEN o.geom
                  ELSE ST_LineInterpolatePoint(o.geom, 0.5) END AS pt
    ) sp
    CROSS JOIN LATERAL (
      SELECT rs.segment_id, rs.geom, rs.ref FROM conditions.road_segment rs
      WHERE rs.geom && ST_Expand(sp.pt, 0.003)
      ORDER BY rs.geom <-> sp.pt LIMIT 6
    ) c
    WHERE o.metric = 'flow'
      AND ST_Distance(c.geom::geography, sp.pt::geography) <= ${maxOffsetM}
      AND ( (o.attributes->>'roads') IS NULL OR c.ref IS NULL
            OR c.ref = (o.attributes->>'roads') OR strpos(o.attributes->>'roads', c.ref) > 0 )
    ORDER BY o.id, ST_Distance(c.geom::geography, sp.pt::geography), c.segment_id
    ON CONFLICT (sensor_key) DO UPDATE SET
      segment_id = EXCLUDED.segment_id, fraction = EXCLUDED.fraction,
      offset_m = EXCLUDED.offset_m, bearing_deg = EXCLUDED.bearing_deg, matched_at = EXCLUDED.matched_at
    RETURNING sensor_key`;

  return { matched: rows.length };
}
