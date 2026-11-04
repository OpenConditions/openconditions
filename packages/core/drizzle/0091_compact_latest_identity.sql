-- Expand both the original reading format and the compact local-id format.
-- This changes no stored rows: writers convert them as readings arrive.
-- Keep this decoder when rolling application code back; older writers and
-- readers using observation_record remain compatible with both formats.
CREATE OR REPLACE FUNCTION "conditions".observation_record(template jsonb, reading jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT (template - 'namespace' - 'provenance') || (reading - 'provenance')
      || jsonb_build_object('provenance',
           (template -> 'provenance') || COALESCE(reading -> 'provenance', '{}'::jsonb))
      || CASE WHEN reading ->> 'id' ~ '^[0-9a-f]{64}$' THEN
           jsonb_build_object(
             'id', 'oc:observation:' || (template ->> 'namespace') || ':' || (reading ->> 'id'),
             'canonicalId', encode(sha256(convert_to(
               '[' || to_json(template ->> 'namespace')::text || ','
                   || to_json(reading ->> 'id')::text || ']', 'UTF8')), 'hex'))
         ELSE '{}'::jsonb END
$$;
