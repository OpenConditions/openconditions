ALTER TABLE "conditions"."federation_instance_key" ADD COLUMN "endorsement_proof" "bytea";--> statement-breakpoint
ALTER TABLE "conditions"."federation_peer_key" ADD COLUMN "anchor" text NOT NULL;