CREATE TABLE "conditions"."federation_tombstone" (
	"canonical_id" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"tombstoned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
