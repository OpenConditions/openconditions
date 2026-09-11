-- Versioned tile-function ownership: runtime startup must not replace newer SQL.
CREATE OR REPLACE FUNCTION conditions.segment_flow(z integer, x integer, y integer, query_params json)
    RETURNS bytea AS $$
    DECLARE bounds geometry := ST_TileEnvelope(z, x, y); mvt bytea;
    BEGIN
      SELECT ST_AsMVT(t, 'segment_flow', 4096, 'geom') INTO mvt FROM (
        SELECT s.segment_id, s.dir, s.highway,
               sp.speed_ratio, sp.los, sp.confidence, sp.current_kph, sp.free_flow_kph,
               ST_AsMVTGeom(ST_Transform(s.geom, 3857), bounds, 4096, 64, true) AS geom
        FROM conditions.road_segment s
        LEFT JOIN conditions.segment_speed sp USING (segment_id)
        WHERE s.min_zoom <= z AND s.geom && ST_Transform(bounds, 4326)
      ) t WHERE t.geom IS NOT NULL;
      RETURN COALESCE(mvt, ''::bytea);
    END;
    $$ LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE;
