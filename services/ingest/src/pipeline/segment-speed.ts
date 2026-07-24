import type postgres from "postgres";

type Sql = postgres.Sql;
// fuseSegmentSpeed and propagateSegmentSpeed both need to run against either
// the top-level pool (their own standalone tests) or an already-open
// transaction (refreshSegmentSpeed, which runs them together inside one
// sql.begin so a tile request never lands between one stage's DELETE and its
// INSERT). See the refreshSegmentSpeed doc comment for why that rules out
// either of them opening a nested sql.begin of their own.
type FuseSql = postgres.Sql | postgres.TransactionSql;

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
  // A flow observation contributes either a measured speed (`o.value` set) or,
  // for a declared-LoS feed (Autobahn Verkehrslage), a speed-less row that
  // carries only `attributes.los`. Both are admitted; a speed-less row writes
  // NULL current_kph/speed_ratio and takes its los straight from the declared
  // status, aggregated worst-first across the sites in a (segment, source)
  // group (a mix of blocked+queuing fuses to blocked, not the alphabetical
  // max). The declared los, when present, wins over the ratio ladder — and the
  // ratio ladder's ELSE 'stationary' arm is only reached when there is a real
  // avg(value), so an all-declared group never misfuses free_flow to stationary.
  const rows = await sql`
    INSERT INTO conditions.segment_observation
      (segment_id, source, source_tier, current_kph, free_flow_kph, speed_ratio, los, confidence, sample_count, observed_at, expires_at)
    SELECT agg.segment_id, agg.source, 'sensor',
      agg.current_kph, agg.free_flow_kph, agg.speed_ratio,
      CASE
        WHEN agg.declared_rank = 4 THEN 'blocked'
        WHEN agg.declared_rank = 3 THEN 'stationary'
        WHEN agg.declared_rank = 2 THEN 'queuing'
        WHEN agg.declared_rank = 1 THEN 'heavy'
        WHEN agg.declared_rank = 0 THEN 'free_flow'
        WHEN agg.free_flow_kph IS NULL OR agg.free_flow_kph <= 0 THEN 'unknown'
        WHEN agg.current_kph / agg.free_flow_kph >= 0.85 THEN 'free_flow'
        WHEN agg.current_kph / agg.free_flow_kph >= 0.5 THEN 'heavy'
        WHEN agg.current_kph / agg.free_flow_kph >= 0.15 THEN 'queuing'
        ELSE 'stationary'
      END,
      0.9, agg.sample_count, agg.observed_at, agg.observed_at + interval '15 minutes'
    FROM (
      SELECT ss.segment_id, o.source,
        avg(o.value) AS current_kph,
        avg(ff.kph) AS free_flow_kph,
        CASE WHEN avg(ff.kph) > 0 AND avg(o.value) IS NOT NULL THEN avg(o.value) / avg(ff.kph) END AS speed_ratio,
        max(
          CASE WHEN o.value IS NULL AND o.attributes->>'los' <> 'unknown' THEN
            CASE o.attributes->>'los'
              WHEN 'blocked' THEN 4 WHEN 'stationary' THEN 3 WHEN 'queuing' THEN 2
              WHEN 'heavy' THEN 1 WHEN 'free_flow' THEN 0 ELSE -1 END
          ELSE -1 END
        ) AS declared_rank,
        count(*) AS sample_count,
        max(o.data_updated_at) AS observed_at
      FROM conditions.sensor_segment ss
      JOIN conditions.observations o ON o.id = ss.sensor_key AND o.metric = 'flow'
        AND (o.value IS NOT NULL OR (o.value IS NULL AND o.attributes->>'los' <> 'unknown'))
      JOIN conditions.road_segment rs ON rs.segment_id = ss.segment_id
      CROSS JOIN LATERAL (SELECT COALESCE((o.attributes->>'freeFlowKph')::float, rs.free_flow_kph) AS kph) ff
      GROUP BY ss.segment_id, o.source
    ) agg
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
  sql: FuseSql,
  now: () => string
): Promise<FuseSegmentSpeedResult> {
  const nowIso = now();

  await sql`DELETE FROM conditions.segment_speed WHERE is_estimated = false`;

  // A column-level merge, not a single-row winner. The speed fields
  // (current_kph/free_flow_kph/speed_ratio) come from the best speed-bearing
  // observation on the segment (highest tier, then freshest); `los` is
  // overridden by a declared-LoS observation when one covers the segment
  // (worst-first across declared sites), else it falls back to the speed row's
  // los. This keeps a co-located measured speed alive on a both-covered segment
  // (so /segments/speed.csv still routes it) while letting the operator's own
  // congestion state paint the overlay. A declared-only segment emits a row with
  // NULL current_kph — filtered out of the routing CSV downstream but coloured
  // by los on the overlay.
  //
  // Deliberate consequence: a declared-only row (is_estimated=false, NULL kph)
  // blocks propagateSegmentSpeed from lending an adjacent measured segment's
  // speed onto it (propagate skips any segment that already has a row). So a
  // segment with only a declared jam is coloured by that jam and does NOT route,
  // rather than showing a neighbour's (possibly free-flow) estimate — the
  // operator's authoritative los wins over an inferred speed. Revisit only if a
  // declared-los + propagated-speed hybrid is ever wanted.
  const rows = await sql`
    WITH live AS (
      SELECT * FROM conditions.segment_observation o
      WHERE o.expires_at IS NULL OR o.expires_at > ${nowIso}::timestamptz
    ),
    speed AS (
      SELECT DISTINCT ON (segment_id)
        segment_id, current_kph, free_flow_kph, speed_ratio, los AS speed_los, source_tier, observed_at
      FROM live
      WHERE current_kph IS NOT NULL
      ORDER BY segment_id,
        CASE source_tier WHEN 'authoritative' THEN 0 WHEN 'sensor' THEN 1 WHEN 'peer' THEN 2 WHEN 'crowd' THEN 3 ELSE 4 END,
        observed_at DESC
    ),
    declared AS (
      SELECT segment_id,
        max(CASE los WHEN 'blocked' THEN 4 WHEN 'stationary' THEN 3 WHEN 'queuing' THEN 2
                     WHEN 'heavy' THEN 1 WHEN 'free_flow' THEN 0 ELSE -1 END) AS los_rank,
        max(observed_at) AS observed_at,
        (array_agg(source_tier ORDER BY observed_at DESC))[1] AS source_tier
      FROM live
      WHERE current_kph IS NULL AND los <> 'unknown'
      GROUP BY segment_id
    ),
    segs AS (
      SELECT segment_id FROM speed
      UNION
      SELECT segment_id FROM declared
    )
    INSERT INTO conditions.segment_speed
      (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, source_tier, contributing, is_estimated, observed_at, updated_at)
    SELECT
      segs.segment_id, sp.current_kph, sp.free_flow_kph, sp.speed_ratio,
      COALESCE(
        CASE d.los_rank WHEN 4 THEN 'blocked' WHEN 3 THEN 'stationary' WHEN 2 THEN 'queuing'
                        WHEN 1 THEN 'heavy' WHEN 0 THEN 'free_flow' ELSE NULL END,
        sp.speed_los
      ),
      'measured', COALESCE(sp.source_tier, d.source_tier),
      ARRAY(SELECT DISTINCT source FROM conditions.segment_observation o2
            WHERE o2.segment_id = segs.segment_id AND (o2.expires_at IS NULL OR o2.expires_at > ${nowIso}::timestamptz)),
      false, COALESCE(sp.observed_at, d.observed_at), ${nowIso}
    FROM segs
    LEFT JOIN speed sp ON sp.segment_id = segs.segment_id
    LEFT JOIN declared d ON d.segment_id = segs.segment_id
    ON CONFLICT (segment_id) DO UPDATE SET
      current_kph=EXCLUDED.current_kph, free_flow_kph=EXCLUDED.free_flow_kph, speed_ratio=EXCLUDED.speed_ratio,
      los=EXCLUDED.los, confidence='measured', source_tier=EXCLUDED.source_tier, contributing=EXCLUDED.contributing,
      is_estimated=false, observed_at=EXCLUDED.observed_at, updated_at=EXCLUDED.updated_at
    RETURNING segment_id`;

  return { measured: rows.length };
}

export interface PropagateSegmentSpeedOptions {
  /** Endpoint-adjacency tolerance in meters for treating a neighbor as a continuation. Defaults to 50. */
  withinM?: number;
  /** Longest neighbor a single measured segment may lend its speed onto, in meters. Defaults to 3000 (see the module doc comment for the FHWA/PeMS grounding). */
  maxNeighborM?: number;
}

export interface PropagateSegmentSpeedResult {
  /** Estimated `segment_speed` rows written this run. */
  estimated: number;
}

/**
 * Fills same-`ref`/`highway` gap segments one hop out from a measured
 * neighbor, run AFTER `fuseSegmentSpeed`. A measured segment lends its
 * absolute `current_kph` onward; the ratio and LOS are recomputed against
 * the *target's own* `free_flow_kph`, not the source's. Every estimated row
 * is deleted and rewritten from scratch each sweep — `ON CONFLICT DO
 * NOTHING` alone would let a stale estimate outlive the measurement that
 * produced it, since nothing else would ever refresh or clear that row. A
 * neighbor only qualifies as a continuation when its start touches the
 * measured segment's end (or vice versa) via `ST_DWithin` on the endpoints
 * specifically — checking the whole geometries would also reach the
 * opposite carriageway of a divided highway, which sits a lane-width away
 * under the same `ref`+`highway`. An endpoint-adjacent neighbor whose
 * overall bearing runs opposite (within a 360°-wraparound-aware 60°) is
 * rejected too, since a junction can still let the opposite-direction
 * segment (or the reversed twin of the same bidirectional way) share an
 * endpoint. Neighbors longer than `maxNeighborM` are excluded so one sensor
 * reading is never stretched across a long, likely-heterogeneous stretch of
 * road. A segment that already has any `segment_speed` row — measured or
 * estimated — is left alone; measured rows always win.
 *
 * Runs its DELETE and INSERT directly against whatever `sql` it is given,
 * rather than wrapping them in an internal `sql.begin` — when called from
 * `refreshSegmentSpeed` that `sql` is already an open transaction
 * (`postgres.TransactionSql`), which exposes `savepoint`, not `begin`, so a
 * second top-level transaction can't be opened there; the outer transaction
 * already gives the DELETE+INSERT here the atomicity it needs. Its own
 * standalone tests call it with the top-level pool instead, where the two
 * statements just run sequentially, which is fine since those tests only
 * assert on state after the call returns, not on interleaving.
 */
export async function propagateSegmentSpeed(
  sql: FuseSql,
  now: () => string,
  opts?: PropagateSegmentSpeedOptions
): Promise<PropagateSegmentSpeedResult> {
  const withinM = opts?.withinM ?? 50;
  const maxNeighborM = opts?.maxNeighborM ?? 3000;
  const nowIso = now();

  await sql`DELETE FROM conditions.segment_speed WHERE is_estimated = true`;

  const rows = await sql`
    INSERT INTO conditions.segment_speed
      (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, source_tier, is_estimated, observed_at, updated_at)
    SELECT DISTINCT ON (nb.segment_id)
      nb.segment_id, m.current_kph, nb.free_flow_kph,
      CASE WHEN nb.free_flow_kph > 0 THEN m.current_kph / nb.free_flow_kph END,
      CASE WHEN nb.free_flow_kph IS NULL OR nb.free_flow_kph <= 0 THEN 'unknown'
           WHEN m.current_kph / nb.free_flow_kph >= 0.85 THEN 'free_flow'
           WHEN m.current_kph / nb.free_flow_kph >= 0.5  THEN 'heavy'
           WHEN m.current_kph / nb.free_flow_kph >= 0.15 THEN 'queuing'
           ELSE 'stationary' END,
      'estimated', 'sensor', true, m.observed_at, ${nowIso}
    FROM conditions.segment_speed m
    JOIN conditions.road_segment ms ON ms.segment_id = m.segment_id
    JOIN conditions.road_segment nb
      ON nb.ref = ms.ref AND nb.highway = ms.highway AND nb.segment_id <> ms.segment_id
     AND nb.length_m <= ${maxNeighborM}
     AND ( ST_DWithin(ST_EndPoint(ms.geom)::geography, ST_StartPoint(nb.geom)::geography, ${withinM})
        OR ST_DWithin(ST_StartPoint(ms.geom)::geography, ST_EndPoint(nb.geom)::geography, ${withinM}) )
    CROSS JOIN LATERAL (
      SELECT abs(degrees(ST_Azimuth(ST_StartPoint(ms.geom), ST_EndPoint(ms.geom)))
               - degrees(ST_Azimuth(ST_StartPoint(nb.geom), ST_EndPoint(nb.geom)))) AS d
    ) bearing
    LEFT JOIN conditions.segment_speed ex ON ex.segment_id = nb.segment_id
    WHERE m.is_estimated = false AND ex.segment_id IS NULL AND m.current_kph IS NOT NULL
      AND least(bearing.d, 360 - bearing.d) <= 60
    ORDER BY nb.segment_id, ST_Distance(nb.geom::geography, ms.geom::geography)
    ON CONFLICT (segment_id) DO NOTHING
    RETURNING segment_id`;

  return { estimated: rows.length };
}

export interface RefreshSegmentSpeedResult {
  /** `segment_observation` rows written by writeSensorObservations. */
  written: number;
  /** Measured `segment_speed` rows written by fuseSegmentSpeed. */
  measured: number;
  /** Estimated `segment_speed` rows written by propagateSegmentSpeed. */
  estimated: number;
}

/**
 * The scheduled entry point for the whole segment-speed surface: write fresh
 * sensor observations, then run fuse and propagate together inside one
 * transaction. fuseSegmentSpeed and propagateSegmentSpeed each start with a
 * DELETE before their INSERT/SELECT, so without one enclosing transaction
 * here a tile request landing between one stage's DELETE and its matching
 * INSERT would see a momentarily empty `segment_speed` table. The whole
 * sequence is one try/catch — a failure anywhere (a bad feed row, a
 * transient DB error) is logged and yields all-zero counts for that cycle
 * rather than throwing, so one bad sweep can never take the scheduler
 * process down with it. On success the counts are logged at info level —
 * the ops signal that the surface is still alive.
 */
export async function refreshSegmentSpeed(
  sql: Sql,
  now: () => string
): Promise<RefreshSegmentSpeedResult> {
  try {
    const { written } = await writeSensorObservations(sql, now);
    const { measured, estimated } = await sql.begin(async (tx) => {
      const fused = await fuseSegmentSpeed(tx, now);
      const propagated = await propagateSegmentSpeed(tx, now);
      return { measured: fused.measured, estimated: propagated.estimated };
    });
    console.info(
      `[ingest] segment-speed refresh: written ${written}, measured ${measured}, estimated ${estimated}`
    );
    return { written, measured, estimated };
  } catch (err) {
    console.error("[ingest] segment-speed refresh failed:", err);
    return { written: 0, measured: 0, estimated: 0 };
  }
}
