ALTER TABLE "conditions"."federation_tombstone" ADD COLUMN "peer_instance_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."federation_tombstone" DROP CONSTRAINT "federation_tombstone_pkey";--> statement-breakpoint
ALTER TABLE "conditions"."federation_tombstone" ADD CONSTRAINT "federation_tombstone_canonical_id_peer_instance_id_pk" PRIMARY KEY("canonical_id","peer_instance_id");
