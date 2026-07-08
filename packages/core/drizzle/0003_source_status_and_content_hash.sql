CREATE TABLE "conditions"."source_status" (
	"source" text PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"freshness_window_sec" integer NOT NULL,
	"last_row_count" integer,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "content_hash" text;