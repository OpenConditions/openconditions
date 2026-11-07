-- New writers keep changing fused contributor IDs once in the reading.
-- No rows are rewritten. Retain this decoder when rolling application code
-- back: older writers still emit a format this function accepts.
CREATE OR REPLACE FUNCTION "conditions".observation_fusion_provenance(
  provenance jsonb, ids jsonb, local_id text
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  merged jsonb;
  refs jsonb;
BEGIN
  IF provenance ->> 'origin' IS DISTINCT FROM 'derived'
     OR COALESCE(provenance ->> 'sourceId', '') NOT IN ('@fused', '@fused-public')
     OR jsonb_typeof(provenance -> 'derivedFrom') IS DISTINCT FROM 'object'
     OR provenance #>> '{derivedFrom,method}' IS DISTINCT FROM 'fusion'
     OR jsonb_typeof(provenance -> 'mergedSources') IS DISTINCT FROM 'array'
     OR jsonb_typeof(ids) IS DISTINCT FROM 'array'
     OR local_id IS NULL OR local_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid compact fused lineage' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(ids) = 0
     OR jsonb_array_length(ids) <> jsonb_array_length(provenance -> 'mergedSources')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(ids) WHERE jsonb_typeof(value) <> 'string')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(provenance -> 'mergedSources')
                WHERE jsonb_typeof(value) <> 'object') THEN
    RAISE EXCEPTION 'Invalid compact fused lineage' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_agg(value || jsonb_build_object('recordId', ids -> (ordinality - 1)::integer)
                   ORDER BY ordinality)
    INTO merged FROM jsonb_array_elements(provenance -> 'mergedSources') WITH ORDINALITY;
  SELECT jsonb_agg(jsonb_build_object('class', 'observation', 'id', value) ORDER BY ordinality)
    INTO refs FROM jsonb_array_elements(ids) WITH ORDINALITY;
  RETURN provenance || jsonb_build_object(
    'recordId', local_id, 'mergedSources', merged,
    'derivedFrom', (provenance -> 'derivedFrom') || jsonb_build_object('records', refs));
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "conditions".observation_record(template jsonb, reading jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT (template - 'namespace' - 'provenance') || (reading - 'provenance' - '_ocFusionRecordIds')
      || jsonb_build_object('provenance',
           CASE WHEN reading ? '_ocFusionRecordIds' THEN
             conditions.observation_fusion_provenance(
               (template -> 'provenance') || COALESCE(reading -> 'provenance', '{}'::jsonb),
               reading -> '_ocFusionRecordIds', reading ->> 'id')
           ELSE (template -> 'provenance') || COALESCE(reading -> 'provenance', '{}'::jsonb) END)
      || CASE WHEN reading ->> 'id' ~ '^[0-9a-f]{64}$' THEN
           jsonb_build_object(
             'id', 'oc:observation:' || (template ->> 'namespace') || ':' || (reading ->> 'id'),
             'canonicalId', encode(sha256(convert_to(
               '[' || to_json(template ->> 'namespace')::text || ','
                   || to_json(reading ->> 'id')::text || ']', 'UTF8')), 'hex'))
         ELSE '{}'::jsonb END
$$;
