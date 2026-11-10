CREATE TABLE "conditions"."smn_cap_decision" (
	"source_id" text PRIMARY KEY NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"decision" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conditions"."smn_cap_message" DROP CONSTRAINT "smn_cap_message_source_id_identifier_pk";--> statement-breakpoint
ALTER TABLE "conditions"."smn_cap_message" ADD COLUMN "variant" text GENERATED ALWAYS AS (encode(sha256(body), 'hex')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."smn_cap_message" ADD COLUMN "retrieval" jsonb DEFAULT '{"legacy":true}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."smn_cap_message" ADD CONSTRAINT "smn_cap_message_source_id_variant_pk" PRIMARY KEY("source_id","variant");
