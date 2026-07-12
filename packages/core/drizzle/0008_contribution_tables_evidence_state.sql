CREATE TABLE "conditions"."issuer_key" (
	"key_id" text PRIMARY KEY NOT NULL,
	"public_key" "bytea" NOT NULL,
	"private_key" "bytea" NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."report_evidence" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"observation_id" text NOT NULL,
	"evidence_kind" text NOT NULL,
	"actor_key_id" text,
	"source_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "report_evidence_kind_enum" CHECK ("conditions"."report_evidence"."evidence_kind" IN ('report','confirm','negate','official_match','reviewer_accept','reviewer_reject','expired'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."reporter" (
	"key_id" text PRIMARY KEY NOT NULL,
	"pub_jwk" jsonb NOT NULL,
	"osm_uid" text,
	"email_lookup_hmac" text,
	"reputation_alpha" double precision NOT NULL,
	"reputation_beta" double precision NOT NULL,
	"corroborated_count" integer DEFAULT 0 NOT NULL,
	"flagged_count" integer DEFAULT 0 NOT NULL,
	"trust_signal" double precision,
	"entitlement_expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reporter_reputation_alpha_positive" CHECK ("conditions"."reporter"."reputation_alpha" > 0),
	CONSTRAINT "reporter_reputation_beta_positive" CHECK ("conditions"."reporter"."reputation_beta" > 0),
	CONSTRAINT "reporter_status_enum" CHECK ("conditions"."reporter"."status" IN ('active','blocked'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."sub_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_id" text NOT NULL,
	"claim_type" text NOT NULL,
	"key_id" text NOT NULL,
	"reason" text,
	"geom" geometry(Point, 4326),
	"signature" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sub_claim_claim_type_enum" CHECK ("conditions"."sub_claim"."claim_type" IN ('confirm','negate','flag'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."token_quota" (
	"key_id" text NOT NULL,
	"epoch" text NOT NULL,
	"issued" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "token_quota_key_id_epoch_pk" PRIMARY KEY("key_id","epoch")
);
--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "evidence_state" text;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD COLUMN "routing_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_report_evidence_observation" ON "conditions"."report_evidence" USING btree ("observation_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sub_claim_subject_key_type" ON "conditions"."sub_claim" USING btree ("subject_id","key_id","claim_type");--> statement-breakpoint
CREATE INDEX "idx_sub_claim_subject" ON "conditions"."sub_claim" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "idx_sub_claim_key" ON "conditions"."sub_claim" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_evidence_state" ON "conditions"."observations" USING btree ("evidence_state");--> statement-breakpoint
ALTER TABLE "conditions"."observations" ADD CONSTRAINT "obs_evidence_state_enum" CHECK ("conditions"."observations"."evidence_state" IS NULL OR "conditions"."observations"."evidence_state" IN ('self_reported','corroborated','externally_resolved','negated','expired'));