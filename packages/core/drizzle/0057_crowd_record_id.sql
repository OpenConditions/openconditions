DROP INDEX "conditions"."idx_observation_latest_crowd_record";--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ADD COLUMN "crowd_record_id" text;--> statement-breakpoint
CREATE INDEX "idx_observation_latest_crowd_record" ON "conditions"."observation_latest" USING btree ("crowd_record_id") WHERE "conditions"."observation_latest"."crowd_record_id" IS NOT NULL;