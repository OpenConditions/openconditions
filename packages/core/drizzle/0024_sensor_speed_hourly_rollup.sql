CREATE TABLE "conditions"."sensor_speed_hourly" (
	"sensor_key" text NOT NULL,
	"hour_utc" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	"sample_count" integer NOT NULL,
	"speed_bins" smallint[] NOT NULL,
	"speed_counts" integer[] NOT NULL,
	CONSTRAINT "sensor_speed_hourly_sensor_key_hour_utc_pk" PRIMARY KEY("sensor_key","hour_utc")
);
--> statement-breakpoint
CREATE INDEX "idx_sensor_hourly_hour" ON "conditions"."sensor_speed_hourly" USING btree ("hour_utc");