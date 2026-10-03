-- A crowd observation stays on the instance that landed it, as a fused row
-- does: its subject is this instance's canonical feature, a cluster of the
-- feature links no peer holds, so the reading would name nothing there.
-- drizzle-kit cannot model functions, so the DDL is authored here.
CREATE OR REPLACE FUNCTION "conditions".federation_observation_capture() RETURNS trigger AS $$
BEGIN
  IF NEW.source_id IN ('@fused', 'crowd')
     OR NOT "conditions".federation_is_own(NEW.record, NEW.access_mode)
     OR NOT EXISTS (
       SELECT 1 FROM "conditions"."federation_subscription" s
       WHERE s.filter -> 'properties' ? NEW.property
         AND (NOT (s.filter ? 'classes') OR s.filter -> 'classes' ? 'observation')) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.record = NEW.record THEN
    RETURN NULL;
  END IF;
  INSERT INTO "conditions"."federation_outbox"
    (operation, record_class, record_id, canonical_id, kind, domain, property, snapshot)
  VALUES (
    CASE TG_OP WHEN 'INSERT' THEN 'create' ELSE 'update' END,
    'observation', NEW.record ->> 'id', NEW.record ->> 'canonicalId', 'observation',
    NEW.record ->> 'domain', NEW.property, NEW.record);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
