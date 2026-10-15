CREATE TABLE "conditions"."source_shrink" (
	"source_id" text NOT NULL,
	"scope" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"polls" integer NOT NULL,
	"stated" integer NOT NULL,
	"held" integer NOT NULL,
	CONSTRAINT "source_shrink_source_id_scope_pk" PRIMARY KEY("source_id","scope"),
	CONSTRAINT "source_shrink_scope_enum" CHECK ("conditions"."source_shrink"."scope" IN ('series','records'))
);
