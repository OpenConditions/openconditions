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
 * Snaps every measurement site of a flow source onto its nearest
 * `road_segment` within `maxOffsetM` (default 35 m) and upserts the binding
 * into `sensor_segment`, keyed by the subject key of the site's `traffic.speed`
 * or `traffic.los` series (`feature:<featureId>`): a site that only states a
 * level of service feeds segment speeds too. Only site-level series count: a
 * site's lane and vehicle-class channels share its location.
 *
 * Two subtleties baked into the SQL:
 * - **`sp` lateral — non-point geometries must be reduced to a snap point
 *   first.** `ST_LineLocatePoint(line, geom)` *errors* unless `geom` is a
 *   POINT. A LineString site (NYC DOT) snaps at its midpoint; a site whose
 *   readings span several lines (a MultiLineString) at the midpoint of its
 *   first line.
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
 * applies the real geography-based offset gate, and a road check: a site
 * whose feature location names road refs snaps only to a segment carrying one
 * of them (refs compared without spaces or case, an OSM `a;b` ref split), so
 * it never takes a parallel road within the gate. A site naming no ref, or a
 * segment without one, is not disqualified: only a stated mismatch is.
 */
export async function matchSensors(
  sql: Sql,
  now: () => string,
  opts?: MatchSensorsOptions,
): Promise<MatchSensorsResult> {
  const maxOffsetM = opts?.maxOffsetM ?? 35;

  const rows = await sql`
    INSERT INTO conditions.sensor_segment (subject_key, segment_id, fraction, offset_m, bearing_deg, matched_at)
    SELECT DISTINCT ON (l.subject_key)
      l.subject_key, c.segment_id,
      ST_LineLocatePoint(c.geom, sp.pt),
      ST_Distance(c.geom::geography, sp.pt::geography),
      degrees(ST_Azimuth(
        ST_LineInterpolatePoint(c.geom, GREATEST(ST_LineLocatePoint(c.geom, sp.pt) - 0.001, 0)),
        ST_LineInterpolatePoint(c.geom, LEAST(ST_LineLocatePoint(c.geom, sp.pt) + 0.001, 1)))),
      ${now()}
    FROM conditions.observation_latest l
    JOIN conditions.source s ON s.id = l.source_id AND s.domain = 'roads' AND s.product = 'flow'
    CROSS JOIN LATERAL (
      SELECT CASE GeometryType(l.geom)
               WHEN 'POINT' THEN l.geom
               WHEN 'MULTILINESTRING' THEN ST_LineInterpolatePoint(ST_GeometryN(l.geom, 1), 0.5)
               ELSE ST_LineInterpolatePoint(l.geom, 0.5) END AS pt
    ) sp
    CROSS JOIN LATERAL (
      SELECT array_agg(DISTINCT upper(regexp_replace(r ->> 'ref', '\\s', '', 'g'))) AS refs
        FROM conditions.feature f,
             jsonb_array_elements(CASE WHEN jsonb_typeof(f.record #> '{location,roads}') = 'array'
                                       THEN f.record #> '{location,roads}'
                                       ELSE '[]'::jsonb END) r
       WHERE f.id = l.feature_id AND f.tombstoned_at IS NULL AND r ->> 'ref' IS NOT NULL
    ) site
    CROSS JOIN LATERAL (
      SELECT rs.segment_id, rs.geom, rs.ref FROM conditions.road_segment rs
      WHERE rs.geom && ST_Expand(sp.pt, 0.003)
      ORDER BY rs.geom <-> sp.pt LIMIT 6
    ) c
    WHERE l.property IN ('traffic.speed', 'traffic.los') AND l.subject_kind = 'feature'
      AND l.component_key IS NULL AND l.geom IS NOT NULL
      AND ST_Distance(c.geom::geography, sp.pt::geography) <= ${maxOffsetM}
      AND (site.refs IS NULL OR c.ref IS NULL OR EXISTS (
            SELECT 1 FROM unnest(string_to_array(c.ref, ';')) AS seg(ref)
             WHERE upper(regexp_replace(seg.ref, '\\s', '', 'g')) = ANY(site.refs)))
    ORDER BY l.subject_key, ST_Distance(c.geom::geography, sp.pt::geography), c.segment_id
    ON CONFLICT (subject_key) DO UPDATE SET
      segment_id = EXCLUDED.segment_id, fraction = EXCLUDED.fraction,
      offset_m = EXCLUDED.offset_m, bearing_deg = EXCLUDED.bearing_deg, matched_at = EXCLUDED.matched_at
    RETURNING subject_key`;

  return { matched: rows.length };
}
