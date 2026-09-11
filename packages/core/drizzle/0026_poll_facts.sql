CREATE TABLE "conditions"."source_poll_attempt" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"network_validated" boolean NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"active_event_count" integer,
	"inserted" integer,
	"updated" integer,
	"deleted" integer,
	"rejected" integer,
	"duration_ms" integer,
	"partitions_succeeded" integer,
	"partitions_failed" integer,
	"partitions_total" integer,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "last_network_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "freshness_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "last_publication_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "publication_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "last_outcome" text;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "active_event_count" integer;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "last_inserted" integer;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "last_updated" integer;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "last_deleted" integer;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "last_rejected" integer;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "last_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."source_status" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_source_poll_attempt_source_time" ON "conditions"."source_poll_attempt" USING btree ("source","attempted_at");--> statement-breakpoint
-- The aggregate WZDx parent is replaced by independently scheduled approved
-- children. Existing aggregate rows cannot be attributed to a concrete
-- publisher, so retain their identity and mark them ineligible rather than
-- relabelling them with an invented child licence.
UPDATE "conditions"."observations"
SET "routing_eligible" = false, "evidence_state" = 'unverified'
WHERE "source" = 'us-wzdx';--> statement-breakpoint
UPDATE "conditions"."source_status"
SET "last_outcome" = 'missing_configuration', "freshness_deadline" = NULL,
    "last_error" = 'Legacy aggregate disabled; awaiting independently verified child replacement',
    "last_error_at" = now(), "updated_at" = now()
WHERE "source" = 'us-wzdx';
