CREATE TABLE "conditions"."sensor_baseline" (
	"sensor_key" text NOT NULL,
	"source" text NOT NULL,
	"dow_bucket" smallint NOT NULL,
	"tod_bucket" smallint NOT NULL,
	"free_flow_kph" double precision NOT NULL,
	"method" text NOT NULL,
	"sample_count" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sensor_baseline_sensor_key_dow_bucket_tod_bucket_method_pk" PRIMARY KEY("sensor_key","dow_bucket","tod_bucket","method")
);
--> statement-breakpoint
CREATE TABLE "conditions"."sensor_speed_sample" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sensor_key" text NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"speed_kph" double precision NOT NULL,
	"dow" smallint NOT NULL,
	"tod_hour" smallint NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	CONSTRAINT "uq_sensor_sample_key_observed" UNIQUE("sensor_key","observed_at")
);
--> statement-breakpoint
CREATE INDEX "idx_sensor_baseline_source_bucket" ON "conditions"."sensor_baseline" USING btree ("source","dow_bucket","tod_bucket");--> statement-breakpoint
CREATE INDEX "idx_sensor_sample_key_bucket" ON "conditions"."sensor_speed_sample" USING btree ("sensor_key","dow","tod_hour");--> statement-breakpoint
CREATE INDEX "idx_sensor_sample_observed" ON "conditions"."sensor_speed_sample" USING btree ("observed_at");