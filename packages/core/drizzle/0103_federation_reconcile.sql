ALTER TABLE "conditions"."federation_peer_capabilities" ADD COLUMN "protocol_version" text;--> statement-breakpoint
ALTER TABLE "conditions"."federation_peer_cursor" ADD COLUMN "reconcile_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conditions"."federation_peer_cursor" ADD COLUMN "reconcile_class" text;--> statement-breakpoint
ALTER TABLE "conditions"."federation_peer_cursor" ADD COLUMN "reconcile_after" text;--> statement-breakpoint
ALTER TABLE "conditions"."federation_peer_cursor" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_feature_id_bytes" ON "conditions"."feature" USING btree ("id" COLLATE "C");--> statement-breakpoint
CREATE INDEX "idx_offer_id_bytes" ON "conditions"."offer" USING btree ("id" COLLATE "C");--> statement-breakpoint
CREATE INDEX "idx_situation_id_bytes" ON "conditions"."situation" USING btree ("id" COLLATE "C");