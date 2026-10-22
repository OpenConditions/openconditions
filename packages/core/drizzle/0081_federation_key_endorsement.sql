CREATE TABLE "conditions"."federation_peer_key" (
	"peer_instance_id" text NOT NULL,
	"key_id" text NOT NULL,
	"learned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "federation_peer_key_peer_instance_id_key_id_pk" PRIMARY KEY("peer_instance_id","key_id")
);
--> statement-breakpoint
ALTER TABLE "conditions"."federation_instance_key" ADD COLUMN "endorsed_by" text;--> statement-breakpoint
ALTER TABLE "conditions"."federation_instance_key" ADD COLUMN "endorsement" "bytea";