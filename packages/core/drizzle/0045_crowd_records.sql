CREATE TABLE "conditions"."federation_peer_capabilities" (
	"peer_instance_id" text PRIMARY KEY NOT NULL,
	"schema_versions" text[] NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conditions"."report_evidence" DROP CONSTRAINT "report_evidence_kind_enum";--> statement-breakpoint
ALTER TABLE "conditions"."sub_claim" DROP CONSTRAINT "sub_claim_claim_type_enum";--> statement-breakpoint
DROP INDEX "conditions"."idx_report_evidence_observation";--> statement-breakpoint
DROP INDEX "conditions"."idx_sub_claim_subject";--> statement-breakpoint
DROP INDEX "conditions"."uq_sub_claim_subject_key_type";--> statement-breakpoint
ALTER TABLE "conditions"."report_evidence" ADD COLUMN "record_class" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."report_evidence" ADD COLUMN "record_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."report_evidence" ADD COLUMN "component_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."sub_claim" ADD COLUMN "subject_class" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."sub_claim" ADD COLUMN "subject_component_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_report_evidence_record" ON "conditions"."report_evidence" USING btree ("record_class","record_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_report_evidence_merged" ON "conditions"."report_evidence" USING btree (("details" ->> 'merged')) WHERE "conditions"."report_evidence"."details" ? 'merged';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sub_claim_subject_key_type" ON "conditions"."sub_claim" USING btree ("subject_class","subject_id","subject_component_key","key_id","claim_type");--> statement-breakpoint
ALTER TABLE "conditions"."report_evidence" DROP COLUMN "observation_id";--> statement-breakpoint
ALTER TABLE "conditions"."report_evidence" ADD CONSTRAINT "report_evidence_record_class_enum" CHECK ("record_class" IN ('feature', 'situation', 'observation', 'offer'));--> statement-breakpoint
ALTER TABLE "conditions"."report_evidence" ADD CONSTRAINT "report_evidence_kind_enum" CHECK ("evidence_kind" IN ('report', 'confirm', 'negate', 'official_match', 'reviewer_accept', 'reviewer_reject'));--> statement-breakpoint
ALTER TABLE "conditions"."sub_claim" ADD CONSTRAINT "sub_claim_subject_class_enum" CHECK ("subject_class" IN ('feature', 'situation', 'observation', 'offer'));--> statement-breakpoint
ALTER TABLE "conditions"."sub_claim" ADD CONSTRAINT "sub_claim_claim_type_enum" CHECK ("claim_type" IN ('confirm', 'negate', 'flag'));