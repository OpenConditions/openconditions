-- The federation outbox journals model records from now on (the next two
-- migrations), so the capture on the flat observations table goes, with its
-- function. Its journal rows and the subscriptions, whose filters named legacy
-- types, are removed: no instance is deployed, so no peer holds a cursor.
DROP TRIGGER IF EXISTS federation_outbox_capture_insert ON "conditions"."observations";--> statement-breakpoint
DROP TRIGGER IF EXISTS federation_outbox_capture_update ON "conditions"."observations";--> statement-breakpoint
DROP TRIGGER IF EXISTS federation_outbox_capture_delete ON "conditions"."observations";--> statement-breakpoint
DROP FUNCTION IF EXISTS "conditions".federation_outbox_capture();--> statement-breakpoint
DELETE FROM "conditions"."federation_outbox";--> statement-breakpoint
DELETE FROM "conditions"."federation_subscription";
