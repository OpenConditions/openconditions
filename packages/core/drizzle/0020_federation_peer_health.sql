CREATE TABLE "conditions"."federation_blocklist" (
	"peer_id" text PRIMARY KEY NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_peer_health" (
	"peer_id" text PRIMARY KEY NOT NULL,
	"availability_ok" integer DEFAULT 0 NOT NULL,
	"availability_fail" integer DEFAULT 0 NOT NULL,
	"signature_failures" integer DEFAULT 0 NOT NULL,
	"replay_failures" integer DEFAULT 0 NOT NULL,
	"schema_failures" integer DEFAULT 0 NOT NULL,
	"rate_violations" integer DEFAULT 0 NOT NULL,
	"effective_tier_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
