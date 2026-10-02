DROP INDEX "conditions"."idx_federation_outbox_object";--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" ADD COLUMN "record_class" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" ADD COLUMN "record_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" ADD COLUMN "domain" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" ADD COLUMN "property" text;--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" ADD COLUMN "priority" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" ADD COLUMN "tombstone_reason" text;--> statement-breakpoint
CREATE INDEX "idx_federation_outbox_record" ON "conditions"."federation_outbox" USING btree ("record_class","record_id","seq");--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" DROP COLUMN "object_id";--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" DROP COLUMN "payload_snapshot";--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" ADD CONSTRAINT "federation_outbox_record_class_enum" CHECK ("record_class" IN ('feature', 'situation', 'observation', 'offer'));--> statement-breakpoint
ALTER TABLE "conditions"."federation_outbox" ADD CONSTRAINT "federation_outbox_delete_shape" CHECK (("conditions"."federation_outbox"."operation" = 'delete') = ("conditions"."federation_outbox"."snapshot" IS NULL AND "conditions"."federation_outbox"."tombstone_reason" IS NOT NULL));