-- Current affirmative policy is synchronized from the reviewed JS registry at boot.
-- Missing measurement evidence and unrecognized IDs fail closed; credits never authorize use.
CREATE FUNCTION conditions.flow_public_licenses(licenses text[])
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT licenses IS NOT NULL AND cardinality(licenses) > 0
    AND NOT EXISTS (SELECT 1 FROM unnest(licenses) l(license)
      WHERE l.license IS NULL OR NOT EXISTS (
        SELECT 1 FROM conditions.public_license_policy p WHERE p.license = l.license));
$$;
--> statement-breakpoint
-- Null/empty member evidence poisons the union instead of silently disappearing.
CREATE FUNCTION conditions.flow_permission_union(inputs jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN inputs IS NOT NULL AND jsonb_array_length(inputs) > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inputs) i
      WHERE jsonb_typeof(i) <> 'array' OR i = '[]'::jsonb)
    THEN ARRAY(SELECT DISTINCT l.license FROM jsonb_array_elements(inputs) i
      CROSS JOIN LATERAL jsonb_array_elements_text(i) l(license) ORDER BY l.license) END;
$$;
--> statement-breakpoint
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
      AND conditions.flow_public_licenses(sp.permission_licenses)
      AND NOT EXISTS (SELECT 1 FROM conditions.source scope_source
        WHERE scope_source.id = ANY(sp.contributing) AND scope_source.restricted)
    WHERE s.min_zoom <= z AND s.geom && ST_Transform(bounds, 4326)
  ) t WHERE t.geom IS NOT NULL;
  RETURN COALESCE(mvt, ''::bytea);
END;
$$ LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE;

--> statement-breakpoint
-- Function-only extension of immutable captured receipts; no stored-data conversion.
-- One projection serves native and explicitly captured upstream sources alike.
CREATE FUNCTION conditions.flow_credit_licensing(supplied jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  captured jsonb := supplied->'licensing';
  captured_url text := NULLIF(supplied->>'licenseUrl','');
  declarations jsonb;
  matched integer;
BEGIN
  IF captured_url IS NULL OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(captured->'declarations','[]'::jsonb)) d WHERE d->>'url'=captured_url
    UNION ALL
    SELECT 1 FROM jsonb_array_elements(COALESCE(captured->'bindings','[]'::jsonb)) b WHERE b #>> '{license,url}'=captured_url
  ) THEN RETURN captured; END IF;
  captured := COALESCE(captured,'{"version":1,"bindings":[]}'::jsonb);
  declarations := COALESCE(captured->'declarations','[]'::jsonb);
  SELECT ordinality::integer-1 INTO matched FROM jsonb_array_elements(declarations) WITH ORDINALITY d(value,ordinality)
    WHERE d.value->>'text'=supplied->>'license' AND NOT d.value ? 'url' ORDER BY ordinality LIMIT 1;
  IF matched IS NOT NULL THEN
    declarations := jsonb_set(declarations,ARRAY[matched::text],(declarations->matched)||jsonb_build_object('url',captured_url));
  ELSE
    IF jsonb_array_length(declarations)>=64 OR length(supplied->>'license')>1000 THEN
      RAISE EXCEPTION 'captured licence URL exceeds portable declaration capacity';
    END IF;
    declarations := declarations || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('text',supplied->>'license','url',captured_url)));
  END IF;
  RETURN jsonb_set(captured,'{declarations}',declarations);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_source_credit(native_source text, supplied jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'sourceId', COALESCE(NULLIF(supplied->>'parentSourceId',''),native_source),
    'name', COALESCE(NULLIF(supplied->>'name',''),supplied->>'provider'),
    'url',supplied->>'url','licensing',conditions.flow_credit_licensing(supplied),
    'attributionText',supplied->>'provider','publisher',supplied->'publisher'
  ))),'[]'::jsonb)
  WHERE COALESCE(NULLIF(supplied->>'name',''),supplied->>'provider') IS NOT NULL;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION conditions.flow_credit(native_source text, supplied jsonb, upstream jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH credits AS (
    SELECT 0 AS ord,c.value AS credit FROM jsonb_array_elements(conditions.flow_source_credit(native_source,supplied)) c
    UNION ALL
    SELECT 1,c.value FROM jsonb_array_elements(COALESCE(upstream,'[]'::jsonb)) u
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN u.value ? 'source'
      THEN conditions.flow_source_credit(u.value #>> '{source,sourceId}',u.value #> '{source,attribution}')
      ELSE CASE WHEN NULLIF(u.value->>'publisher','') IS NOT NULL
        THEN jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'sourceId',COALESCE(NULLIF(supplied->>'parentSourceId',''),native_source),
          'name',COALESCE(NULLIF(supplied->>'name',''),supplied->>'provider') || ' – ' || (u.value->>'publisher'),
          'licensing',u.value->'licensing','attributionText',u.value->>'attribution',
          'publisher',jsonb_build_object('name',u.value->>'publisher')
        ))) ELSE '[]'::jsonb END END) c
  ) SELECT COALESCE(jsonb_agg(credit ORDER BY ord,credit::text),'[]'::jsonb)
    FROM (SELECT credit,min(ord) AS ord FROM credits GROUP BY credit) unique_credits;
$$;
--> statement-breakpoint
-- Both declared selectors remain policy facts even for unsealed custom inputs.
CREATE OR REPLACE FUNCTION conditions.flow_receipt_permissions(receipt_ids text[], complete boolean, receipt_version integer)
RETURNS text[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN complete IS TRUE THEN conditions.flow_permission_union(jsonb_agg(
    CASE WHEN r.provenance #>> '{attribution,license}' IS NOT NULL THEN to_jsonb(
      ARRAY[r.provenance #>> '{attribution,license}'] || ARRAY(
        SELECT l.license FROM jsonb_array_elements(COALESCE(r.provenance->'upstream','[]'::jsonb)) u
        CROSS JOIN LATERAL(VALUES (CASE WHEN u ? 'license' THEN COALESCE(u->>'license','') END),(CASE WHEN u ? 'source' THEN COALESCE(u #>> '{source,attribution,license}','') END)) l(license)
        WHERE l.license IS NOT NULL)) END)) END
  FROM unnest(receipt_ids) ids(receipt_id)
  LEFT JOIN conditions.contributor_receipt r ON r.id=ids.receipt_id AND r.version=receipt_version;
$$;
