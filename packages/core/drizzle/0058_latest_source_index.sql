DROP INDEX "conditions"."idx_observation_latest_property";--> statement-breakpoint
CREATE INDEX "idx_observation_latest_source" ON "conditions"."observation_latest" USING btree ("source_id");