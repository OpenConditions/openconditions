CREATE TABLE "conditions"."smn_cap_message" (
	"source_id" text NOT NULL,
	"identifier" text NOT NULL,
	"body" "bytea" NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "smn_cap_message_source_id_identifier_pk" PRIMARY KEY("source_id","identifier")
);
