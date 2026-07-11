ALTER TABLE "conditions"."observations" ADD COLUMN "instance_id" text;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "canonical_id" text;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "phenomenon_fingerprint" text;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "replaces" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "corroborations" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "fuzziness" text DEFAULT 'exact' NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "confidence_score" double precision;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "severity_level" smallint;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "privacy_class" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "k_anonymity" integer;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "dp_epsilon" double precision;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "dp_delta" double precision;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "informed" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "source_uri" text;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "source_license" text;--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_canonical" ON "conditions"."observations" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_phenomenon" ON "conditions"."observations" USING btree ("phenomenon_fingerprint");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_instance" ON "conditions"."observations" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_privacy" ON "conditions"."observations" USING btree ("privacy_class");--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_confidence_score_range" CHECK ("conditions"."observations"."confidence_score" IS NULL OR ("conditions"."observations"."confidence_score" >= 0 AND "conditions"."observations"."confidence_score" <= 1));--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_dp_epsilon_nonneg" CHECK ("conditions"."observations"."dp_epsilon" IS NULL OR "conditions"."observations"."dp_epsilon" >= 0);--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_dp_delta_range" CHECK ("conditions"."observations"."dp_delta" IS NULL OR ("conditions"."observations"."dp_delta" >= 0 AND "conditions"."observations"."dp_delta" < 1));--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_k_anonymity_positive" CHECK ("conditions"."observations"."k_anonymity" IS NULL OR "conditions"."observations"."k_anonymity" > 0);--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_severity_level_range" CHECK ("conditions"."observations"."severity_level" IS NULL OR ("conditions"."observations"."severity_level" >= 1 AND "conditions"."observations"."severity_level" <= 5));--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_fuzziness_enum" CHECK ("conditions"."observations"."fuzziness" IN ('exact','low_res','medium_res','end_unknown','start_unknown','extent_unknown'));--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_privacy_class_enum" CHECK ("conditions"."observations"."privacy_class" IN ('unknown','authoritative','aggregate','k_anon','dp_noised','crowd_pseudonym'));