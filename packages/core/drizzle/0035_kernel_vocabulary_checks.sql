ALTER TABLE "conditions"."observations" DROP CONSTRAINT "obs_fuzziness_enum";--> statement-breakpoint
ALTER TABLE "conditions"."observations" DROP CONSTRAINT "obs_privacy_class_enum";--> statement-breakpoint
ALTER TABLE "conditions"."observations" DROP CONSTRAINT "obs_evidence_state_enum";--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_fuzziness_enum" CHECK ("fuzziness" IN ('exact', 'low_res', 'medium_res', 'end_unknown', 'start_unknown', 'extent_unknown'));--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_privacy_class_enum" CHECK ("privacy_class" IN ('authoritative', 'aggregate', 'k_anon', 'dp_noised', 'crowd_pseudonym', 'unknown'));--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_evidence_state_enum" CHECK ("conditions"."observations"."evidence_state" IS NULL OR "evidence_state" IN ('self_reported', 'corroborated', 'externally_resolved', 'negated', 'expired'));