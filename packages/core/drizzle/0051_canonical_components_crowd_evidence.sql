ALTER TABLE "conditions"."observation_latest" ADD COLUMN "evidence_state" text;--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ADD COLUMN "confidence_score" double precision;--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ADD COLUMN "corroborations" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."feature_canonical" ADD COLUMN "components" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_observation_latest_crowd_record" ON "conditions"."observation_latest" USING btree (("record" ->> 'id')) WHERE "conditions"."observation_latest"."source_id" = 'crowd';--> statement-breakpoint
CREATE INDEX "idx_feature_external_ids" ON "conditions"."feature" USING gin (("record" -> 'externalIds') jsonb_path_ops);--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ADD CONSTRAINT "observation_latest_evidence_state_enum" CHECK (evidence_state IS NULL OR "evidence_state" IN ('self_reported', 'corroborated', 'externally_resolved', 'negated', 'expired'));