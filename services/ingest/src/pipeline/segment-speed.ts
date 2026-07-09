import type postgres from "postgres";

type Sql = postgres.Sql;

export interface WriteSensorObservationsResult {
  /** Rows inserted or updated in `segment_observation` this run. */
  written: number;
}

/**
 * Writes one `segment_observation` row per (segment, feed source), tier
 * `'sensor'` — the multi-source/crowd/federation fusion seam (see the
 * `segmentObservation` schema doc comment). A segment routinely carries
 * several sensors from the same source (NDW spacing is ~500 m, so a segment
 * typically sees 2-4 stations); freshest-only would arbitrarily discard the
 * rest, so this averages `current_kph`/`free_flow_kph` across every sensor of
 * that source bound to the segment via `sensor_segment` and feeds `count(*)`
 * into `sample_count`. The LOS ladder mirrors `losFromSpeedRatio` in
 * `packages/roads/src/flow.ts` exactly, computed on the aggregated means so a
 * segment's classification reflects its overall condition rather than any
 * single sensor. `free_flow_kph` prefers the per-reading
 * `attributes.freeFlowKph` (Phase A's per-sensor baseline) and falls back to
 * the segment's own `road_segment.free_flow_kph`; when neither is known
 * (e.g. a Trafikverket-style feed with no baseline, on a segment OSM never
 * gave a maxspeed) the ratio and LOS are left `NULL`/`'unknown'`.
 * `expires_at` is the freshest reading's `data_updated_at` plus 15 minutes,
 * so the fusion step (2b) can drop a source that has gone stale.
 */
export async function writeSensorObservations(
  sql: Sql,
  _now: () => string
): Promise<WriteSensorObservationsResult> {
  const rows = await sql`
    INSERT INTO conditions.segment_observation
      (segment_id, source, source_tier, current_kph, free_flow_kph, speed_ratio, los, confidence, sample_count, observed_at, expires_at)
    SELECT ss.segment_id, o.source, 'sensor',
      avg(o.value), avg(ff.kph),
      CASE WHEN avg(ff.kph) > 0 THEN avg(o.value) / avg(ff.kph) END,
      CASE WHEN avg(ff.kph) IS NULL OR avg(ff.kph) <= 0 THEN 'unknown'
           WHEN avg(o.value) / avg(ff.kph) >= 0.85 THEN 'free_flow'  WHEN avg(o.value) / avg(ff.kph) >= 0.5 THEN 'heavy'
           WHEN avg(o.value) / avg(ff.kph) >= 0.15 THEN 'queuing'    ELSE 'stationary' END,
      0.9, count(*), max(o.data_updated_at), max(o.data_updated_at) + interval '15 minutes'
    FROM conditions.sensor_segment ss
    JOIN conditions.observations o ON o.id = ss.sensor_key AND o.metric = 'flow' AND o.value IS NOT NULL
    JOIN conditions.road_segment rs ON rs.segment_id = ss.segment_id
    CROSS JOIN LATERAL (SELECT COALESCE((o.attributes->>'freeFlowKph')::float, rs.free_flow_kph) AS kph) ff
    GROUP BY ss.segment_id, o.source
    ON CONFLICT (segment_id, source) DO UPDATE SET
      current_kph=EXCLUDED.current_kph, free_flow_kph=EXCLUDED.free_flow_kph, speed_ratio=EXCLUDED.speed_ratio,
      los=EXCLUDED.los, confidence=EXCLUDED.confidence, sample_count=EXCLUDED.sample_count,
      observed_at=EXCLUDED.observed_at, expires_at=EXCLUDED.expires_at
    RETURNING segment_id`;

  return { written: rows.length };
}

export interface FuseSegmentSpeedResult {
  /** Measured `segment_speed` rows written this run. */
  measured: number;
}

/**
 * Reduces every unexpired `segment_observation` row per segment to a single
 * measured `segment_speed` row — the multi-source fusion seam: a second
 * source (TomTom/HERE), a crowd aggregate, or a federation peer is a new
 * `segment_observation` row with its own tier, not a rearchitect of this
 * step. v1 reducer = **highest tier, then freshest** (tier order
 * `authoritative > sensor > peer > crowd`); the weighted/Kalman-per-segment
 * upgrade is a later drop-in replacement for this one query only. Estimated
 * rows (written by the propagation step) are left untouched —
 * only `is_estimated = false` rows are cleared and rewritten here, so measured
 * always wins over estimated by construction. `contributing` lists every
 * still-live source id on the segment (not just the winning tier's), so a
 * fused estimate stays auditable and re-fusable by a peer.
 */
export async function fuseSegmentSpeed(
  sql: Sql,
  now: () => string
): Promise<FuseSegmentSpeedResult> {
  const nowIso = now();

  await sql`DELETE FROM conditions.segment_speed WHERE is_estimated = false`;

  const rows = await sql`
    INSERT INTO conditions.segment_speed
      (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, source_tier, contributing, is_estimated, observed_at, updated_at)
    SELECT DISTINCT ON (o.segment_id)
      o.segment_id, o.current_kph, o.free_flow_kph, o.speed_ratio, o.los, 'measured', o.source_tier,
      ARRAY(SELECT DISTINCT source FROM conditions.segment_observation o2
            WHERE o2.segment_id = o.segment_id AND (o2.expires_at IS NULL OR o2.expires_at > ${nowIso}::timestamptz)),
      false, o.observed_at, ${nowIso}
    FROM conditions.segment_observation o
    WHERE o.expires_at IS NULL OR o.expires_at > ${nowIso}::timestamptz
    ORDER BY o.segment_id,
      CASE o.source_tier WHEN 'authoritative' THEN 0 WHEN 'sensor' THEN 1 WHEN 'peer' THEN 2 WHEN 'crowd' THEN 3 ELSE 4 END,
      o.observed_at DESC
    ON CONFLICT (segment_id) DO UPDATE SET
      current_kph=EXCLUDED.current_kph, free_flow_kph=EXCLUDED.free_flow_kph, speed_ratio=EXCLUDED.speed_ratio,
      los=EXCLUDED.los, confidence='measured', source_tier=EXCLUDED.source_tier, contributing=EXCLUDED.contributing,
      is_estimated=false, observed_at=EXCLUDED.observed_at, updated_at=EXCLUDED.updated_at
    RETURNING segment_id`;

  return { measured: rows.length };
}
