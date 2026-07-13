CREATE TABLE "conditions"."federation_subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"peer_id" text NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivery_mode" text DEFAULT 'pull' NOT NULL,
	"inbox_url" text,
	"cursor" text DEFAULT '0.0' NOT NULL,
	"priority_only" boolean DEFAULT true NOT NULL,
	"push_failures" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "federation_subscription_delivery_mode_enum" CHECK ("conditions"."federation_subscription"."delivery_mode" IN ('pull','webhook','sse'))
);
--> statement-breakpoint
CREATE INDEX "idx_federation_subscription_peer" ON "conditions"."federation_subscription" USING btree ("peer_id");