CREATE TABLE "conditions"."federation_outbox" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"object_id" text NOT NULL,
	"operation" text NOT NULL,
	"canonical_id" text,
	"payload_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_outbox_operation_enum" CHECK ("conditions"."federation_outbox"."operation" IN ('create','update','delete'))
);
--> statement-breakpoint
CREATE INDEX "idx_federation_outbox_object" ON "conditions"."federation_outbox" USING btree ("object_id","seq");
--> statement-breakpoint
-- Transactional capture: an AFTER row trigger on conditions.observations
-- appends one journal entry per mutation in the mutation's own transaction
-- (a rollback appends nothing). INSERT -> 'create', UPDATE -> 'update',
-- DELETE -> a minimal tombstone marker. The payload is the point-in-time row
-- as jsonb with geometry rendered as GeoJSON and origin.reporter STRIPPED so
-- no pseudonymous reporter keyId/signature ever rests in the journal
-- (matching the app-level stripReporter: origin keeps only kind/attribution).
-- Trigger DDL lives here because drizzle-kit cannot model functions/triggers.
CREATE FUNCTION "conditions".federation_outbox_capture() RETURNS trigger AS $$
DECLARE
  payload jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO "conditions"."federation_outbox" (object_id, operation, canonical_id, payload_snapshot)
    VALUES (OLD.id, 'delete', OLD.canonical_id,
            jsonb_build_object('id', OLD.id, 'canonical_id', OLD.canonical_id, 'tombstone', true));
    RETURN OLD;
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
--> statement-breakpoint
CREATE TRIGGER federation_outbox_capture_insert
AFTER INSERT ON "conditions"."observations"
FOR EACH ROW EXECUTE FUNCTION "conditions".federation_outbox_capture();
--> statement-breakpoint
-- The WHEN guard keeps a no-op UPDATE statement (identical row image) from
-- journalling a spurious 'update' — the swap upsert already gates on
-- content_hash, but any other UPDATE path is covered here too.
CREATE TRIGGER federation_outbox_capture_update
AFTER UPDATE ON "conditions"."observations"
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION "conditions".federation_outbox_capture();
--> statement-breakpoint
CREATE TRIGGER federation_outbox_capture_delete
AFTER DELETE ON "conditions"."observations"
FOR EACH ROW EXECUTE FUNCTION "conditions".federation_outbox_capture();