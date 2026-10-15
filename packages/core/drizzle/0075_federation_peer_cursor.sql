CREATE TABLE "conditions"."federation_peer_cursor" (
	"peer_instance_id" text PRIMARY KEY NOT NULL,
	"cursor" text DEFAULT '0.0' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
