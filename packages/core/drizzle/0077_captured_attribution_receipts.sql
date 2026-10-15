CREATE TABLE "conditions"."public_license_policy" (
	"license" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conditions"."contributor_receipt" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."observation_rollup_daily" ADD COLUMN "contributor_receipt_ids" text[];--> statement-breakpoint
ALTER TABLE "conditions"."observation_rollup_daily" ADD COLUMN "lineage_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."observation_rollup_hourly" ADD COLUMN "contributor_receipt_ids" text[];--> statement-breakpoint
ALTER TABLE "conditions"."observation_rollup_hourly" ADD COLUMN "lineage_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."segment_observation" ADD COLUMN "permission_licenses" text[];--> statement-breakpoint
ALTER TABLE "conditions"."segment_profile" ADD COLUMN "contributor_receipt_ids" text[];--> statement-breakpoint
ALTER TABLE "conditions"."segment_profile" ADD COLUMN "lineage_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."segment_profile" ADD COLUMN "permission_licenses" text[];--> statement-breakpoint
ALTER TABLE "conditions"."segment_speed" ADD COLUMN "permission_licenses" text[];--> statement-breakpoint
ALTER TABLE "conditions"."sensor_baseline" ADD COLUMN "contributor_receipt_ids" text[];--> statement-breakpoint
ALTER TABLE "conditions"."sensor_baseline" ADD COLUMN "lineage_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."sensor_baseline" ADD COLUMN "permission_licenses" text[];--> statement-breakpoint
ALTER TABLE "conditions"."sensor_baseline" ADD COLUMN "contributing" text[];