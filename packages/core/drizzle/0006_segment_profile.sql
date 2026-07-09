CREATE TABLE "conditions"."segment_profile" (
	"segment_id" text NOT NULL,
	"dow" smallint NOT NULL,
	"tod_hour" smallint NOT NULL,
	"speed_kph" double precision NOT NULL,
	"sample_count" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "segment_profile_segment_id_dow_tod_hour_pk" PRIMARY KEY("segment_id","dow","tod_hour")
);
--> statement-breakpoint
CREATE INDEX "idx_segment_profile_segment" ON "conditions"."segment_profile" USING btree ("segment_id");