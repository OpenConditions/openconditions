import type { Attribution, Effect, RoutingRights, Validity } from "@openconditions/model";
import type { LineString } from "geojson";
import type { QueryRunner } from "./query-runner.js";

/** Effect kinds that constrain where or how a vehicle may drive. */
export const ROUTING_EFFECT_KINDS = [
  "closure",
  "lane_restriction",
  "speed_limit",
  "access",
  "dimension_limit",
  "hazmat",
] as const;

/**
 * One effect of a live road situation, bound to the segment spine, as the
 * routing read returns it: the situation's classification and validity, the
 * effect, the binding of the location the effect applies to (its own, or the
 * situation's) with its ordered spans, and the source's freshness. The ingest
 * service fills the catalogue fields (rights, licence URL, parent source)
 * before projecting it.
 *
 * A span's `geometry` is the occupied part of the directed segment in travel
 * direction, `null` when a spine rebuild dropped the segment since binding.
 */
export interface SegmentConditionRow {
  record_id: string;
  effect_id: string;
  source_id: string;
  kind: string;
  type: string;
  subtype: string | null;
  severity: string;
  validity: Validity;
  effect: Effect;
  origin: string;
  evidence_state: string | null;
  routing_eligible: boolean | null;
  record_revision: number;
  expires_at: string | Date | null;
  provenance_attribution: Attribution;
  source_uri: string | null;
  source_checked_at: string | Date | null;
  fresh_until: string | Date | null;
  binding_status: string;
  binding_confidence: number | null;
  binding_resolver_version: string;
  binding_direction_mode: string;
  binding_revision: number;
  graph_generation: string;
  segments: Array<{
    segmentId: string;
    wayId: number;
    dir: "f" | "b";
    startFraction: number;
    endFraction: number;
    geometry: LineString | null;
  }>;
  /** Filled from the feed catalogue: the policy source a catalogue child licenses under. */
  routing_source_id?: string;
  child_source_id?: string | null;
  license_url?: string | null;
  attribution?: string | null;
  rights?: RoutingRights | null;
}

/**
 * Half-width, in metres, of the geometry read for a point-located binding. A
 * point binds to a span with `start_fraction = end_fraction`, and
 * `ST_LineSubstring` on a zero-length range returns a GeoJSON `Point`, which
 * would break the `LineString | null` contract. Widening the cut by 10 m
 * either side keeps the consumer's map-matching input a line while the
 * fractions stay equal and truthful about where the effect is.
 */
export const POINT_SPAN_HALF_M = 10;

export interface SegmentConditionQuery {
  /** Effects whose validity ended before this instant are not read. */
  at: Date;
  bbox?: [number, number, number, number];
  /** Only bindings computed by this resolver version count. */
  resolverVersion: string;
}

/**
 * The bound, routing-relevant effects of live road situations: every effect
 * of a routing kind, and every effect that is restriction evidence (listed,
 * never routed). Only `exact` and `likely` bindings on the active graph
 * generation are read; an effect with its own location reads its own
 * binding, an effect without one the situation's. An effect whose own
 * location has no geometry (only a description) applies somewhere the
 * situation's binding does not establish, so it is not read at all. Ordered
 * by situation, then effect.
 */
export async function readSegmentConditionRows(
  db: QueryRunner,
  q: SegmentConditionQuery,
): Promise<SegmentConditionRow[]> {
  const params: unknown[] = [q.at.toISOString(), q.resolverVersion, [...ROUTING_EFFECT_KINDS]];
  if (q.bbox) params.push(...q.bbox);
  return db.execute<SegmentConditionRow[]>(
    `SELECT e.situation_id AS record_id, e.effect_id, s.source_id, s.kind, s.type, s.subtype,
            s.severity, s.record -> 'validity' AS validity, e.value AS effect, s.origin,
            s.evidence_state, s.routing_eligible, s.revision AS record_revision, s.expires_at,
            s.record #> '{provenance,attribution}' AS provenance_attribution,
            s.record #>> '{provenance,sourceUri}' AS source_uri,
            ss.last_network_success_at AS source_checked_at,
            ss.freshness_deadline AS fresh_until,
            b.status AS binding_status, b.confidence AS binding_confidence,
            b.resolver_version AS binding_resolver_version,
            b.direction_mode AS binding_direction_mode,
            b.record_revision AS binding_revision, b.graph_generation,
            COALESCE(seg.segments, '[]'::jsonb) AS segments
       FROM conditions.situation_effect e
       JOIN conditions.situation s ON s.id = e.situation_id
       JOIN conditions.record_binding b ON b.record_class = 'situation' AND b.record_id = s.id
        AND b.effect_id = CASE WHEN jsonb_typeof(e.value #> '{location,geometry}') = 'object'
                               THEN e.effect_id
                               WHEN e.value -> 'location' IS NULL THEN '' END
       JOIN conditions.road_graph_state graph ON graph.singleton AND graph.status = 'ready'
        AND graph.generation = b.graph_generation
       LEFT JOIN conditions.source_status ss ON ss.source = s.source_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('segmentId', r.segment_id,
                  'wayId', r.way_id, 'dir', r.dir,
                  'startFraction', r.start_fraction, 'endFraction', r.end_fraction,
                  'geometry', CASE
                    WHEN rs.geom IS NULL THEN NULL
                    WHEN r.start_fraction = r.end_fraction THEN
                      CASE WHEN rs.length_m > 0
                           THEN ST_AsGeoJSON(ST_LineSubstring(rs.geom,
                                  GREATEST(0, r.start_fraction - (${POINT_SPAN_HALF_M})::double precision / rs.length_m),
                                  LEAST(1, r.start_fraction + (${POINT_SPAN_HALF_M})::double precision / rs.length_m)))::jsonb
                           ELSE NULL END
                    ELSE ST_AsGeoJSON(ST_LineSubstring(rs.geom,
                           LEAST(r.start_fraction, r.end_fraction),
                           GREATEST(r.start_fraction, r.end_fraction)))::jsonb END)
                  ORDER BY r.seq) AS segments
           FROM conditions.record_segment r
           LEFT JOIN conditions.road_segment rs ON rs.segment_id = r.segment_id
          WHERE r.record_class = 'situation' AND r.record_id = b.record_id
            AND r.effect_id = b.effect_id) seg ON true
      WHERE s.tombstoned_at IS NULL AND s.domain = 'roads'
        AND (e.kind = ANY($3::text[]) OR e.applicability_kind = 'unknown'
             OR e.normalization <> 'complete')
        AND b.status IN ('exact', 'likely') AND b.resolver_version = $2
        AND (e.valid_to IS NULL OR e.valid_to > $1::timestamptz)
        AND (s.expires_at IS NULL OR s.expires_at > now())
        ${q.bbox ? "AND e.geom && ST_MakeEnvelope($4, $5, $6, $7, 4326)" : ""}
      ORDER BY e.situation_id, e.effect_id`,
    params,
  );
}
