CREATE TABLE "conditions"."observation_revision" (
	"source_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"property" text NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"rank" text NOT NULL,
	"signature" text NOT NULL,
	"suppressed" boolean NOT NULL,
	CONSTRAINT "observation_revision_source_id_feature_id_property_pk" PRIMARY KEY("source_id","feature_id","property")
);
