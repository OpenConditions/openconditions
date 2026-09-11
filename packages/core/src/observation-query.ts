// Shared SQL for readers of the same observation/binding projection.
const BINDING_CURRENT_SQL = `(b.observation_revision IS NOT NULL
      AND b.observation_revision = o.content_hash
      AND b.graph_generation IS NOT NULL
      AND b.graph_generation = graph.generation
      AND graph.status = 'ready')`;

export const BINDING_SELECT_SQL = `,
    CASE WHEN b.observation_id IS NULL THEN NULL
         WHEN ${BINDING_CURRENT_SQL} THEN b.status ELSE 'obsolete' END AS binding_status,
    CASE WHEN ${BINDING_CURRENT_SQL} THEN b.confidence ELSE NULL END AS binding_confidence,
    CASE WHEN ${BINDING_CURRENT_SQL} THEN b.direction_mode ELSE 'unknown' END AS binding_direction_mode,
    CASE WHEN ${BINDING_CURRENT_SQL} THEN seg.segments ELSE NULL END AS segments`;

export const BINDING_JOIN_SQL = `
    LEFT JOIN conditions.observation_binding b ON b.observation_id = o.id
    LEFT JOIN conditions.road_graph_state graph ON graph.singleton
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('segmentId', s.segment_id, 'wayId', s.way_id, 'dir', s.dir,
                       'startFraction', s.start_fraction, 'endFraction', s.end_fraction) ORDER BY s.seq) AS segments
      FROM conditions.observation_segment s WHERE s.observation_id = o.id) seg ON true`;
