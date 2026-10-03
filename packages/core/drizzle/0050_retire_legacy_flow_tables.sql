ALTER TABLE "conditions"."observations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conditions"."sensor_speed_hourly" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conditions"."sensor_speed_sample" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conditions"."speed_rollup_progress" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "conditions"."observations" CASCADE;--> statement-breakpoint
DROP TABLE "conditions"."sensor_speed_hourly" CASCADE;--> statement-breakpoint
DROP TABLE "conditions"."sensor_speed_sample" CASCADE;--> statement-breakpoint
DROP TABLE "conditions"."speed_rollup_progress" CASCADE;--> statement-breakpoint
-- Hand-ordered: drizzle-kit adds the new primary key before its column and a
-- second primary key beside the old one. The rows are derived (baselines and
-- snaps are recomputed from the new series), so they are cleared rather than
-- re-keyed.
DELETE FROM "conditions"."sensor_baseline";--> statement-breakpoint
DELETE FROM "conditions"."sensor_segment";--> statement-breakpoint
ALTER TABLE "conditions"."sensor_baseline" DROP CONSTRAINT "sensor_baseline_sensor_key_dow_bucket_tod_bucket_method_pk";--> statement-breakpoint
ALTER TABLE "conditions"."sensor_baseline" DROP COLUMN "sensor_key";--> statement-breakpoint
ALTER TABLE "conditions"."sensor_baseline" ADD COLUMN "subject_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."sensor_baseline" ADD CONSTRAINT "sensor_baseline_subject_key_dow_bucket_tod_bucket_method_pk" PRIMARY KEY("subject_key","dow_bucket","tod_bucket","method");--> statement-breakpoint
ALTER TABLE "conditions"."sensor_segment" DROP COLUMN "sensor_key";--> statement-breakpoint
ALTER TABLE "conditions"."sensor_segment" ADD COLUMN "subject_key" text PRIMARY KEY NOT NULL;
