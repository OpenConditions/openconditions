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

/** How long a site's reading stands for its segment. */
const READING_LIFETIME_MIN = 15;

/**
 * Writes one `segment_observation` row per (segment, feed source), tier
 * `'sensor'` — the multi-source/crowd/federation fusion seam (see the
 * `segmentObservation` schema doc comment). A segment routinely carries
 * several sites from the same source (NDW spacing is ~500 m, so a segment
 * typically sees 2-4 stations); freshest-only would arbitrarily discard the
 * rest, so this averages `current_kph`/`free_flow_kph` across every site of
 * that source bound to the segment via `sensor_segment` and feeds the count
 * into `sample_count`.
 *
 * A site contributes its `traffic.speed` and `traffic.los` readings younger
 * than 15 minutes (`observation_latest`, site level), aged from the end of a
 * reading's period, so a 15-minute mean still counts when it is published.
 * A level of service is written only when it changes: it is aged from its
 * source's last successful poll, which restated it, when that is later.
 * The LOS ladder mirrors the flow parsers' `losFromSpeedRatio` exactly,
 * computed on the aggregated means so a segment's classification reflects
 * its overall condition rather than any single site. `free_flow_kph` prefers
 * the free-flow speed of the reading's own baseline and falls back to the
 * segment's `road_segment.free_flow_kph`; when neither is known (e.g. a
 * Trafikverket-style feed with no baseline, on a segment OSM never gave a
 * maxspeed) the ratio and LOS are left `NULL`/`'unknown'`. `expires_at` is
 * the freshest reading's time plus 15 minutes, so the fusion step can drop a
 * source that has gone stale.
 */
export async function writeSensorObservations(
  sql: Sql,
  now: () => string,
): Promise<WriteSensorObservationsResult> {
  // A site contributes either a measured speed or, for a declared-LoS feed
  // (Autobahn Verkehrslage), only the level of service it states. Both are
  // admitted; a speed-less site writes NULL current_kph/speed_ratio and takes
  // its los straight from the declared status, aggregated worst-first across
  // the sites in a (segment, source) group (a mix of blocked+queuing fuses to
  // blocked, not the alphabetical max). The declared los, when present, wins
  // over the ratio ladder — and the ladder's ELSE 'stationary' arm is only
  // reached when there is a real mean speed, so an all-declared group never
  // misfuses free_flow to stationary.
  const rows = await sql`
    WITH raw AS (
      SELECT l.subject_key, l.source_id, l.property, l.value_num, l.value_text,
        (l.reading #>> '{baseline,freeFlow,value}')::double precision AS free_flow,
        l.reading #>> '{baseline,source}' AS baseline_source,
        receipt.contributors AS credit, receipt.id IS NOT NULL AS receipt_complete,
        COALESCE(l.effective_until, l.effective_from) AS input_at,
        CASE WHEN l.property = 'traffic.los'
          THEN GREATEST(COALESCE(l.effective_until, l.effective_from), st.last_success_at)
          ELSE COALESCE(l.effective_until, l.effective_from) END AS at
      FROM conditions.sensor_segment ss
      JOIN conditions.observation_latest l ON l.subject_key = ss.subject_key
      JOIN conditions.source s
        ON s.id = l.source_id AND s.domain = 'roads' AND s.product = 'flow'
      LEFT JOIN conditions.contributor_receipt receipt ON receipt.id = l.contributor_receipt_id AND receipt.version = 1
      LEFT JOIN conditions.source_status st ON st.source = l.source_id
      WHERE l.property IN ('traffic.speed', 'traffic.los')
    ), fresh AS (
      SELECT * FROM raw
       WHERE at >= ${now()}::timestamptz - make_interval(mins => ${READING_LIFETIME_MIN})
    ), selected AS (
      SELECT fresh.*,
        max(free_flow) FILTER (WHERE property = 'traffic.speed') OVER (PARTITION BY subject_key, source_id) AS selected_free_flow,
        max(value_text) FILTER (WHERE property = 'traffic.los') OVER (PARTITION BY subject_key, source_id) AS selected_los,
        max(value_num) FILTER (WHERE property = 'traffic.speed') OVER (PARTITION BY subject_key, source_id) AS selected_speed
      FROM fresh
    ), site AS (
      SELECT subject_key, source_id AS source,
        max(value_num) FILTER (WHERE property = 'traffic.speed') AS speed,
        max(free_flow) FILTER (WHERE property = 'traffic.speed') AS free_flow,
        max(value_text) FILTER (WHERE property = 'traffic.los') AS los,
        max(at) AS observed_at,
        bool_and(receipt_complete) FILTER (WHERE property = 'traffic.speed' AND value_num = selected_speed) AS speed_complete,
        bool_and(receipt_complete) FILTER (WHERE property = 'traffic.speed' AND free_flow = selected_free_flow) AS free_flow_complete,
        bool_and(receipt_complete) FILTER (WHERE property = 'traffic.los' AND value_text = selected_los) AS los_complete,
        conditions.flow_credit_union(jsonb_agg(credit) FILTER (WHERE property = 'traffic.speed' AND value_num = selected_speed)) AS speed_credit,
        conditions.flow_credit_union(jsonb_agg(credit) FILTER (WHERE property = 'traffic.los' AND value_text = selected_los)) AS los_credit,
        conditions.flow_credit_union(jsonb_agg(credit) FILTER (WHERE free_flow = selected_free_flow AND baseline_source <> 'osm_maxspeed')) AS native_free_flow_credit,
        bool_or(baseline_source = 'osm_maxspeed' AND receipt_complete) FILTER (WHERE free_flow = selected_free_flow) AS baseline_osm,
        bool_or(baseline_source <> 'osm_maxspeed') FILTER (WHERE free_flow = selected_free_flow) AS baseline_native
      FROM selected GROUP BY subject_key, source_id
    ), bound AS (
      SELECT site.*, ss.segment_id, rs.free_flow_kph AS graph_free_flow,
        COALESCE(site.free_flow, rs.free_flow_kph) AS ff_kph,
        max(CASE WHEN site.speed IS NULL THEN CASE site.los
          WHEN 'blocked' THEN 4 WHEN 'stationary' THEN 3 WHEN 'queuing' THEN 2
          WHEN 'heavy' THEN 1 WHEN 'free_flow' THEN 0 ELSE -1 END ELSE -1 END)
          OVER (PARTITION BY ss.segment_id, site.source) AS worst
      FROM site
      JOIN conditions.sensor_segment ss ON ss.subject_key = site.subject_key
      JOIN conditions.road_segment rs ON rs.segment_id = ss.segment_id
      WHERE site.speed IS NOT NULL OR site.los <> 'unknown'
    )
    INSERT INTO conditions.segment_observation
      (segment_id, source, source_tier, current_kph, free_flow_kph, speed_ratio, los, confidence, sample_count, observed_at, expires_at, native_field_sources, field_sources, field_contributors, field_lineage_complete)
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
      0.9, agg.sample_count, agg.observed_at,
      agg.observed_at + make_interval(mins => ${READING_LIFETIME_MIN}),
      conditions.flow_native_field_sources(agg.field_contributors, agg.source),
      conditions.flow_field_sources(agg.field_contributors), agg.field_contributors, agg.completeness
    FROM (
      SELECT base.*, jsonb_build_object(
        'speed', COALESCE(speed_complete, current_kph IS NULL),
        'freeFlow', COALESCE(free_flow_complete, free_flow_kph IS NULL),
        'ratio', speed_ratio IS NULL OR (COALESCE(speed_complete,false) AND COALESCE(free_flow_complete,false)),
        'los', CASE WHEN declared_rank >= 0 THEN COALESCE(los_complete,false)
                    ELSE speed_ratio IS NULL OR (COALESCE(speed_complete,false) AND COALESCE(free_flow_complete,false)) END,
        'geometry', true) AS completeness, conditions.flow_known_fields(jsonb_build_object(
        'speed', CASE WHEN current_kph IS NOT NULL THEN speed_credit ELSE '[]'::jsonb END,
        'freeFlow', free_flow_credit,
        'ratio', CASE WHEN speed_ratio IS NOT NULL THEN conditions.flow_credit_union(speed_credit || free_flow_credit) ELSE '[]'::jsonb END,
        'los', CASE WHEN declared_rank >= 0 THEN los_credit
                    WHEN speed_ratio IS NOT NULL THEN conditions.flow_credit_union(speed_credit || free_flow_credit) ELSE '[]'::jsonb END,
        'geometry', conditions.flow_osm_credit())) AS field_contributors
      FROM (
      SELECT site.segment_id, site.source,
        avg(site.speed) AS current_kph,
        avg(site.ff_kph) AS free_flow_kph,
        CASE WHEN avg(site.ff_kph) > 0 AND avg(site.speed) IS NOT NULL
          THEN avg(site.speed) / avg(site.ff_kph) END AS speed_ratio,
        max(
          CASE WHEN site.speed IS NULL THEN
            CASE site.los
              WHEN 'blocked' THEN 4 WHEN 'stationary' THEN 3 WHEN 'queuing' THEN 2
              WHEN 'heavy' THEN 1 WHEN 'free_flow' THEN 0 ELSE -1 END
          ELSE -1 END
        ) AS declared_rank,
        count(*) AS sample_count,
        max(site.observed_at) AS observed_at,
        bool_and(site.speed_complete) FILTER (WHERE site.speed IS NOT NULL) AS speed_complete,
        bool_and(CASE WHEN site.free_flow IS NULL THEN true ELSE site.free_flow_complete END)
          FILTER (WHERE site.ff_kph IS NOT NULL) AS free_flow_complete,
        bool_and(site.los_complete) FILTER (WHERE site.speed IS NULL AND
          CASE site.los WHEN 'blocked' THEN 4 WHEN 'stationary' THEN 3 WHEN 'queuing' THEN 2
            WHEN 'heavy' THEN 1 WHEN 'free_flow' THEN 0 ELSE -1 END = site.worst) AS los_complete,
        conditions.flow_credit_union(jsonb_agg(site.speed_credit)) AS speed_credit,
        conditions.flow_credit_union(jsonb_agg(site.los_credit) FILTER (WHERE site.speed IS NULL AND
          CASE site.los WHEN 'blocked' THEN 4 WHEN 'stationary' THEN 3 WHEN 'queuing' THEN 2
            WHEN 'heavy' THEN 1 WHEN 'free_flow' THEN 0 ELSE -1 END = site.worst)) AS los_credit,
        conditions.flow_credit_union(jsonb_agg(
          (CASE WHEN (site.free_flow IS NULL AND site.graph_free_flow IS NOT NULL) OR site.baseline_osm
             THEN conditions.flow_osm_credit() ELSE '[]'::jsonb END) ||
          (CASE WHEN site.free_flow IS NOT NULL AND site.baseline_native
             THEN site.native_free_flow_credit ELSE '[]'::jsonb END)
        )) AS free_flow_credit
      FROM bound site
      GROUP BY site.segment_id, site.source
    ) base
    ) agg
    ON CONFLICT (segment_id, source) DO UPDATE SET
      current_kph=EXCLUDED.current_kph, free_flow_kph=EXCLUDED.free_flow_kph, speed_ratio=EXCLUDED.speed_ratio,
      los=EXCLUDED.los, confidence=EXCLUDED.confidence, sample_count=EXCLUDED.sample_count,
      observed_at=EXCLUDED.observed_at, expires_at=EXCLUDED.expires_at,
      native_field_sources=EXCLUDED.native_field_sources, field_lineage_complete=EXCLUDED.field_lineage_complete,
      field_contributors=EXCLUDED.field_contributors, field_sources=EXCLUDED.field_sources
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
  now: () => string,
): Promise<FuseSegmentSpeedResult> {
  const nowIso = now();

  // NULL legacy receipts remain unknown. Non-sensor writers must capture
  // their proven field origins with the measurement, before it reaches fusion.
  await sql`DELETE FROM conditions.segment_speed WHERE is_estimated = false`;

  // Confidence is a producer-derived class, not observation.confidence:
  // measured credits the selected speed input when present, otherwise the
  // selected declared LOS ties. Estimated confidence also depends on the OSM
  // geometry used to bind/propagate that donor, even with no target baseline.
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
        segment_id, source, current_kph, free_flow_kph, speed_ratio, los AS speed_los, source_tier, observed_at,
        field_contributors, native_field_sources, field_lineage_complete
      FROM live
      WHERE current_kph IS NOT NULL
      ORDER BY segment_id,
        CASE source_tier WHEN 'authoritative' THEN 0 WHEN 'sensor' THEN 1 WHEN 'peer' THEN 2 WHEN 'crowd' THEN 3 ELSE 4 END,
        observed_at DESC, source
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
    declared_lineage AS (
      SELECT l.segment_id, conditions.flow_credit_union(jsonb_agg(l.field_contributors->'los')) AS credits,
        jsonb_agg(DISTINCT l.source ORDER BY l.source) AS native_ids,
        bool_and(COALESCE((l.field_lineage_complete->>'los')::boolean, l.field_contributors ? 'los', false)) AS complete
      FROM live l JOIN declared d ON d.segment_id = l.segment_id
      WHERE l.current_kph IS NULL AND CASE l.los WHEN 'blocked' THEN 4 WHEN 'stationary' THEN 3
        WHEN 'queuing' THEN 2 WHEN 'heavy' THEN 1 WHEN 'free_flow' THEN 0 ELSE -1 END = d.los_rank
      GROUP BY l.segment_id
    ),
    segs AS (
      SELECT segment_id FROM speed
      UNION
      SELECT segment_id FROM declared
    )
    INSERT INTO conditions.segment_speed
      (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, source_tier, contributing, is_estimated, observed_at, updated_at, native_field_sources, field_sources, field_contributors, field_lineage_complete)
    SELECT
      segs.segment_id, sp.current_kph, sp.free_flow_kph, sp.speed_ratio,
      COALESCE(
        CASE d.los_rank WHEN 4 THEN 'blocked' WHEN 3 THEN 'stationary' WHEN 2 THEN 'queuing'
                        WHEN 1 THEN 'heavy' WHEN 0 THEN 'free_flow' ELSE NULL END,
        sp.speed_los
      ),
      CASE WHEN sp.segment_id IS NOT NULL THEN 'measured'
           WHEN d.segment_id IS NOT NULL THEN 'measured' END, COALESCE(sp.source_tier, d.source_tier),
      ARRAY(SELECT DISTINCT source FROM conditions.segment_observation o2
            WHERE o2.segment_id = segs.segment_id AND (o2.expires_at IS NULL OR o2.expires_at > ${nowIso}::timestamptz)),
      false, COALESCE(sp.observed_at, d.observed_at), ${nowIso},
      lineage.native_fields, conditions.flow_field_sources(lineage.fields), lineage.fields, lineage.completeness
    FROM segs
    LEFT JOIN speed sp ON sp.segment_id = segs.segment_id
    LEFT JOIN declared d ON d.segment_id = segs.segment_id
    LEFT JOIN declared_lineage ON declared_lineage.segment_id = segs.segment_id
    CROSS JOIN LATERAL (
      SELECT (CASE WHEN d.los_rank IS NOT NULL THEN COALESCE(sp.field_contributors, '{}'::jsonb) - 'los'
        ELSE COALESCE(sp.field_contributors, '{}'::jsonb) END) || jsonb_build_object(
        'geometry', conditions.flow_osm_credit()) ||
        CASE WHEN d.los_rank IS NOT NULL AND jsonb_array_length(declared_lineage.credits) > 0 THEN jsonb_build_object('los', declared_lineage.credits)
             ELSE '{}'::jsonb END ||
        CASE WHEN sp.current_kph IS NOT NULL AND sp.field_contributors ? 'speed'
          THEN jsonb_build_object('confidence', sp.field_contributors->'speed')
          WHEN sp.current_kph IS NULL AND jsonb_array_length(declared_lineage.credits) > 0
          THEN jsonb_build_object('confidence', declared_lineage.credits)
          ELSE '{}'::jsonb END AS fields,
      COALESCE(sp.field_lineage_complete, '{}'::jsonb) || jsonb_build_object(
        'geometry', true,
        'speed', COALESCE((sp.field_lineage_complete->>'speed')::boolean, sp.field_contributors ? 'speed', sp.current_kph IS NULL),
        'freeFlow', COALESCE((sp.field_lineage_complete->>'freeFlow')::boolean, sp.field_contributors ? 'freeFlow', sp.free_flow_kph IS NULL),
        'ratio', COALESCE((sp.field_lineage_complete->>'ratio')::boolean, sp.field_contributors ? 'ratio', sp.speed_ratio IS NULL),
        'los', CASE WHEN d.los_rank IS NOT NULL THEN declared_lineage.complete
          ELSE COALESCE((sp.field_lineage_complete->>'los')::boolean, sp.field_contributors ? 'los', sp.speed_los IS NULL OR sp.speed_los = 'unknown') END,
        'confidence', CASE WHEN sp.current_kph IS NOT NULL THEN COALESCE((sp.field_lineage_complete->>'speed')::boolean, sp.field_contributors ? 'speed', false)
          ELSE COALESCE(declared_lineage.complete,false) END) AS completeness,
      COALESCE(sp.native_field_sources, '{}'::jsonb) ||
        CASE WHEN sp.current_kph IS NOT NULL THEN jsonb_build_object('speed', jsonb_build_array(sp.source))
          ELSE '{}'::jsonb END || jsonb_build_object(
        'geometry', jsonb_build_array('openstreetmap'),
        'los', CASE WHEN d.los_rank IS NOT NULL THEN declared_lineage.native_ids
                    ELSE COALESCE(sp.native_field_sources->'los', '[]'::jsonb) END) ||
        CASE WHEN sp.current_kph IS NOT NULL THEN jsonb_build_object('confidence', jsonb_build_array(sp.source))
          ELSE jsonb_build_object('confidence', declared_lineage.native_ids) END AS native_fields
    ) lineage
    ON CONFLICT (segment_id) DO UPDATE SET
      current_kph=EXCLUDED.current_kph, free_flow_kph=EXCLUDED.free_flow_kph, speed_ratio=EXCLUDED.speed_ratio,
      los=EXCLUDED.los, confidence='measured', source_tier=EXCLUDED.source_tier, contributing=EXCLUDED.contributing,
      is_estimated=false, observed_at=EXCLUDED.observed_at, updated_at=EXCLUDED.updated_at,
      native_field_sources=EXCLUDED.native_field_sources, field_sources=EXCLUDED.field_sources,
      field_contributors=EXCLUDED.field_contributors, field_lineage_complete=EXCLUDED.field_lineage_complete
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
 * estimated — is left alone; measured rows always win. An estimate keeps its
 * measurement's `contributing` sources, so the public scope withholds it
 * wherever it withholds the measurement.
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
  opts?: PropagateSegmentSpeedOptions,
): Promise<PropagateSegmentSpeedResult> {
  const withinM = opts?.withinM ?? 50;
  const maxNeighborM = opts?.maxNeighborM ?? 3000;
  const nowIso = now();

  await sql`DELETE FROM conditions.segment_speed WHERE is_estimated = true`;

  const rows = await sql`
    INSERT INTO conditions.segment_speed
      (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, source_tier, contributing, is_estimated, observed_at, updated_at, native_field_sources, field_sources, field_contributors, field_lineage_complete)
    SELECT DISTINCT ON (nb.segment_id)
      nb.segment_id, m.current_kph, nb.free_flow_kph,
      CASE WHEN nb.free_flow_kph > 0 THEN m.current_kph / nb.free_flow_kph END,
      CASE WHEN nb.free_flow_kph IS NULL OR nb.free_flow_kph <= 0 THEN 'unknown'
           WHEN m.current_kph / nb.free_flow_kph >= 0.85 THEN 'free_flow'
           WHEN m.current_kph / nb.free_flow_kph >= 0.5  THEN 'heavy'
           WHEN m.current_kph / nb.free_flow_kph >= 0.15 THEN 'queuing'
           ELSE 'stationary' END,
      'estimated', 'sensor', m.contributing, true, m.observed_at, ${nowIso},
      lineage.native_fields, conditions.flow_field_sources(lineage.fields), lineage.fields, lineage.completeness
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
    CROSS JOIN LATERAL (
      SELECT CASE WHEN nb.free_flow_kph IS NOT NULL THEN conditions.flow_osm_credit() ELSE '[]'::jsonb END AS ff,
        CASE WHEN nb.free_flow_kph > 0 THEN conditions.flow_credit_union(
          COALESCE(m.field_contributors->'speed', '[]'::jsonb) || conditions.flow_osm_credit()) ELSE '[]'::jsonb END AS ratio
    ) target
    CROSS JOIN LATERAL (
      SELECT conditions.flow_known_fields(jsonb_build_object(
        'freeFlow', target.ff, 'geometry', conditions.flow_osm_credit(),
        'speed', COALESCE(m.field_contributors->'speed','[]'::jsonb),
        'ratio', target.ratio, 'los', target.ratio,
        'confidence', conditions.flow_credit_union(COALESCE(m.field_contributors->'speed','[]'::jsonb) || conditions.flow_osm_credit()))) AS fields,
      jsonb_build_object('geometry',true,'freeFlow',true,
        'speed', COALESCE((m.field_lineage_complete->>'speed')::boolean,m.field_contributors ? 'speed',false),
        'ratio', nb.free_flow_kph IS NULL OR nb.free_flow_kph <= 0 OR COALESCE((m.field_lineage_complete->>'speed')::boolean,m.field_contributors ? 'speed',false),
        'los', nb.free_flow_kph IS NULL OR nb.free_flow_kph <= 0 OR COALESCE((m.field_lineage_complete->>'speed')::boolean,m.field_contributors ? 'speed',false),
        'confidence', COALESCE((m.field_lineage_complete->>'speed')::boolean,m.field_contributors ? 'speed',false)) AS completeness,
      jsonb_build_object('freeFlow', CASE WHEN nb.free_flow_kph IS NOT NULL THEN jsonb_build_array('openstreetmap') ELSE '[]'::jsonb END,
        'geometry', jsonb_build_array('openstreetmap')) || CASE WHEN m.native_field_sources ? 'speed' THEN jsonb_build_object(
        'speed', m.native_field_sources->'speed',
        'confidence', m.native_field_sources->'speed' || jsonb_build_array('openstreetmap'),
        'ratio', CASE WHEN nb.free_flow_kph > 0 THEN m.native_field_sources->'speed' || jsonb_build_array('openstreetmap') ELSE '[]'::jsonb END,
        'los', CASE WHEN nb.free_flow_kph > 0 THEN m.native_field_sources->'speed' || jsonb_build_array('openstreetmap') ELSE '[]'::jsonb END)
        ELSE '{}'::jsonb END AS native_fields
    ) lineage
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
  now: () => string,
): Promise<RefreshSegmentSpeedResult> {
  try {
    const { written } = await writeSensorObservations(sql, now);
    const { measured, estimated } = await sql.begin(async (tx) => {
      const fused = await fuseSegmentSpeed(tx, now);
      const propagated = await propagateSegmentSpeed(tx, now);
      return { measured: fused.measured, estimated: propagated.estimated };
    });
    console.info(
      `[ingest] segment-speed refresh: written ${written}, measured ${measured}, estimated ${estimated}`,
    );
    return { written, measured, estimated };
  } catch (err) {
    console.error("[ingest] segment-speed refresh failed:", err);
    return { written: 0, measured: 0, estimated: 0 };
  }
}
