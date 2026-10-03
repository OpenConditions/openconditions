DROP INDEX "conditions"."idx_observation_latest_crowd_record";--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ADD COLUMN "reading" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ADD COLUMN "template_hash" text NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_observation_latest_crowd_record" ON "conditions"."observation_latest" USING btree (("reading" ->> 'id')) WHERE "conditions"."observation_latest"."source_id" = 'crowd';--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" DROP COLUMN "record";