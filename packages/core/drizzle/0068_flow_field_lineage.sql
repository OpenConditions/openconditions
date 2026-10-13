CREATE TABLE "conditions"."contributor_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"version" smallint NOT NULL,
	"contributors" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ADD COLUMN "contributor_receipt_id" text;--> statement-breakpoint
ALTER TABLE "conditions"."segment_observation" ADD COLUMN "native_field_sources" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."segment_observation" ADD COLUMN "field_sources" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."segment_observation" ADD COLUMN "field_contributors" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."segment_observation" ADD COLUMN "field_lineage_complete" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."segment_speed" ADD COLUMN "native_field_sources" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."segment_speed" ADD COLUMN "field_sources" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."segment_speed" ADD COLUMN "field_contributors" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."segment_speed" ADD COLUMN "field_lineage_complete" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "credit_name" text;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "credit_url" text;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "credit_notice" text;
--> statement-breakpoint
-- Native identity remains in rights/contributing; display identity follows the parent.
-- Capture these arrays when the measurement is written, never at feature rendering.
CREATE FUNCTION conditions.flow_credit(native_source text, supplied jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH RECURSIVE ancestry AS (
    SELECT s.*, ARRAY[s.id] AS path FROM conditions.source s WHERE s.id = COALESCE(NULLIF(supplied->>'parentSourceId',''), native_source)
    UNION ALL
    SELECT s.*, a.path || s.id FROM ancestry a JOIN conditions.source s ON s.id = a.parent_source_id
      WHERE NULLIF(supplied->>'parentSourceId','') IS NULL AND NOT s.id = ANY(a.path)
  ), publisher AS (
    SELECT * FROM ancestry ORDER BY cardinality(path) DESC LIMIT 1
  ), identity AS (
    SELECT COALESCE(NULLIF(supplied->>'parentSourceId',''),
                     (SELECT COALESCE(parent_source_id, id) FROM publisher), native_source) AS id
  ), credits AS (
    SELECT 0 AS ord, jsonb_strip_nulls(jsonb_build_object(
      'sourceId', identity.id,
      'name', COALESCE(supplied->>'name', p.credit_name, supplied->>'provider', p.operator, native_source),
      'url', COALESCE(p.credit_url, supplied->>'url'),
      'spdxLicense', COALESCE(supplied->>'license', p.license),
      'licenseUrl', COALESCE(supplied->>'licenseUrl', p.license_url),
      'attributionText', COALESCE(supplied->>'provider', p.attribution),
      'publisher', CASE WHEN p.operator IS NOT NULL THEN jsonb_build_object('name', p.operator) END
    )) AS credit FROM identity LEFT JOIN publisher p ON true
    UNION ALL
    SELECT 1, jsonb_build_object('sourceId', identity.id, 'name', a.credit_notice)
    FROM (SELECT credit_notice FROM ancestry UNION ALL
      SELECT credit_notice FROM conditions.source WHERE id = native_source AND parent_source_id = NULLIF(supplied->>'parentSourceId','')) a CROSS JOIN identity WHERE a.credit_notice IS NOT NULL AND a.credit_notice <> ''
  ) SELECT COALESCE(jsonb_agg(credit ORDER BY ord, credit::text), '[]'::jsonb)
    FROM (SELECT DISTINCT ord, credit FROM credits) c;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_credit_union(credits jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_agg(value ORDER BY value::text), '[]'::jsonb)
  FROM (SELECT DISTINCT flat.value FROM jsonb_array_elements(COALESCE(credits, '[]'::jsonb)) entry
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(entry.value) = 'array'
      THEN entry.value ELSE jsonb_build_array(entry.value) END) flat
    WHERE jsonb_typeof(flat.value) = 'object') c;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_field_sources(fields jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_object_agg(key, ids) FROM (
    SELECT f.key, COALESCE(jsonb_agg(DISTINCT c.value->>'sourceId' ORDER BY c.value->>'sourceId')
      FILTER (WHERE c.value->>'sourceId' IS NOT NULL), '[]'::jsonb) AS ids
    FROM jsonb_each(fields) f LEFT JOIN LATERAL jsonb_array_elements(f.value) c ON true
    GROUP BY f.key
  ) values_by_field;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_osm_credit()
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '[{"sourceId":"openstreetmap","name":"OpenStreetMap","url":"https://www.openstreetmap.org/copyright","spdxLicense":"ODbL-1.0","attributionText":"© OpenStreetMap contributors"}]'::jsonb;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_native_field_sources(fields jsonb, native_source text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_object_agg(key, ids) FROM (
    SELECT f.key, COALESCE(jsonb_agg(DISTINCT CASE WHEN c.value->>'sourceId' = 'openstreetmap'
        THEN 'openstreetmap' ELSE native_source END ORDER BY CASE WHEN c.value->>'sourceId' = 'openstreetmap'
        THEN 'openstreetmap' ELSE native_source END) FILTER (WHERE c.value IS NOT NULL), '[]'::jsonb) AS ids
    FROM jsonb_each(fields) f LEFT JOIN LATERAL jsonb_array_elements(f.value) c ON true GROUP BY f.key
  ) values_by_field;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_known_fields(fields jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(fields)
  WHERE jsonb_typeof(value) = 'array' AND jsonb_array_length(value) > 0;
$$;
--> statement-breakpoint
-- Existing rows retain their valid values with null measurement lineage until a normal sweep.
CREATE OR REPLACE FUNCTION conditions.segment_flow(z integer, x integer, y integer, query_params json)
RETURNS bytea AS $$
DECLARE bounds geometry := ST_TileEnvelope(z, x, y); mvt bytea;
BEGIN
  SELECT ST_AsMVT(t, 'segment_flow', 4096, 'geom') INTO mvt FROM (
    SELECT s.segment_id, s.dir, s.highway,
      sp.speed_ratio, sp.los, sp.confidence, sp.current_kph, sp.free_flow_kph,
      1 AS lineage_version,
      COALESCE(sp.field_sources, jsonb_build_object('geometry', jsonb_build_array('openstreetmap')))::text AS field_sources,
      COALESCE(sp.field_contributors, jsonb_build_object('geometry', conditions.flow_osm_credit()))::text AS field_contributors,
      COALESCE(sp.field_lineage_complete, jsonb_build_object('geometry',true,'speed',sp.current_kph IS NULL,'freeFlow',sp.free_flow_kph IS NULL,'ratio',sp.speed_ratio IS NULL,'los',sp.los IS NULL,'confidence',sp.confidence IS NULL))::text AS field_lineage_complete,
      ST_AsMVTGeom(ST_Transform(s.geom, 3857), bounds, 4096, 64, true) AS geom
    FROM conditions.road_segment s
    LEFT JOIN conditions.segment_speed sp ON sp.segment_id = s.segment_id
      AND NOT EXISTS (SELECT 1 FROM conditions.source scope_source
        WHERE scope_source.id = ANY(sp.contributing) AND scope_source.restricted)
    WHERE s.min_zoom <= z AND s.geom && ST_Transform(bounds, 4326)
  ) t WHERE t.geom IS NOT NULL;
  RETURN COALESCE(mvt, ''::bytea);
END;
$$ LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE;
