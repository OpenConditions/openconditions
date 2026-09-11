-- An erasure that strengthens an archived record must propagate to peers.
-- Preserve existing capture gating, payloads and reporter stripping.
CREATE OR REPLACE FUNCTION "conditions".federation_outbox_capture() RETURNS trigger AS $$
DECLARE
  payload jsonb;
BEGIN
  -- No subscriber, no journal. AFTER-trigger return values are ignored; OLD/NEW
  -- is returned to match the shape of the paths below.
  IF NOT EXISTS (SELECT 1 FROM "conditions"."federation_subscription") THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- A bare DELETE with no reason is a TTL/expiry sweep -> 'expired'.
    INSERT INTO "conditions"."federation_outbox" (object_id, operation, canonical_id, payload_snapshot)
    VALUES (OLD.id, 'delete', OLD.canonical_id,
            jsonb_build_object('id', OLD.id, 'canonical_id', OLD.canonical_id, 'tombstone', true,
                               'reason', COALESCE(OLD.tombstone_reason, 'expired')));
    RETURN OLD;
  END IF;
  -- A soft tombstone: the reviewer/GDPR/operator path scrubs + archives the row
  -- (status -> 'archived') keeping the audit ledger. It must propagate as a
  -- federation DELETION, not a content update, so emit a signed tombstone marker
  -- with the row's reason instead of the 'update' payload.
  IF TG_OP = 'UPDATE' AND NEW.status = 'archived'
     AND (OLD.status <> 'archived' OR NEW.tombstone_reason IS DISTINCT FROM OLD.tombstone_reason) THEN
    INSERT INTO "conditions"."federation_outbox" (object_id, operation, canonical_id, payload_snapshot)
    VALUES (NEW.id, 'delete', NEW.canonical_id,
            jsonb_build_object('id', NEW.id, 'canonical_id', NEW.canonical_id, 'tombstone', true,
                               'reason', COALESCE(NEW.tombstone_reason, 'deleted_by_source')));
    RETURN NEW;
  END IF;
  payload := (to_jsonb(NEW) - 'geom')
    || jsonb_build_object('geom', ST_AsGeoJSON(NEW.geom)::jsonb);
  IF payload -> 'origin' ? 'reporter' THEN
    payload := jsonb_set(payload, '{origin}', (payload -> 'origin') - 'reporter');
  END IF;
  INSERT INTO "conditions"."federation_outbox" (object_id, operation, canonical_id, payload_snapshot)
  VALUES (NEW.id, CASE TG_OP WHEN 'INSERT' THEN 'create' ELSE 'update' END, NEW.canonical_id, payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
