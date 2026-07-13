ALTER TABLE "conditions"."observations" ADD COLUMN "tombstone_reason" text;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_tombstone_reason_enum" CHECK ("conditions"."observations"."tombstone_reason" IS NULL OR "conditions"."observations"."tombstone_reason" IN ('deleted_by_source','gdpr_erasure','retracted_as_wrong','expired','legal_takedown'));--> statement-breakpoint
-- Extend the outbox capture trigger (migration 0014) so a deletion carries its
-- REASON, and a soft-archive tombstone (status -> 'archived') propagates as a
-- federation DELETE rather than a content UPDATE. Non-tombstone create/update
-- behaviour is unchanged. CREATE OR REPLACE keeps the existing triggers bound to
-- this same function name; drizzle-kit cannot model functions, so the DDL lives
-- inline here (same as 0014).
CREATE OR REPLACE FUNCTION "conditions".federation_outbox_capture() RETURNS trigger AS $$
DECLARE
  payload jsonb;
BEGIN
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
  IF TG_OP = 'UPDATE' AND NEW.status = 'archived' AND OLD.status <> 'archived' THEN
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