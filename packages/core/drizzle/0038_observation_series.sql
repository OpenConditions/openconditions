CREATE TABLE "conditions"."observation_latest" (
	"series_id" bigserial PRIMARY KEY NOT NULL,
	"subject_key" text NOT NULL,
	"property" text NOT NULL,
	"qualifier_key" text DEFAULT '' NOT NULL,
	"source_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"feature_id" text,
	"component_key" text,
	"situation_id" text,
	"geom" geometry(Geometry, 4326),
	"record" jsonb NOT NULL,
	"template" jsonb NOT NULL,
	"access_mode" text NOT NULL,
	"result_type" text NOT NULL,
	"value_num" double precision,
	"value_money" numeric(14, 4),
	"value_text" text,
	"unit" text,
	"currency" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"since_at" timestamp with time zone NOT NULL,
	"fused_from" text[],
	"expires_at" timestamp with time zone,
	"retention_days" smallint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_latest_series" UNIQUE("subject_key","property","qualifier_key","source_id"),
	CONSTRAINT "observation_latest_access_mode_enum" CHECK ("access_mode" IN ('bulk', 'on_demand'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."observation_rollup_daily" (
	"series_id" bigint NOT NULL,
	"day_utc" date NOT NULL,
	"sample_count" integer NOT NULL,
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"mean" double precision NOT NULL,
	CONSTRAINT "observation_rollup_daily_series_id_day_utc_pk" PRIMARY KEY("series_id","day_utc")
);
--> statement-breakpoint
CREATE TABLE "conditions"."observation_rollup_hourly" (
	"series_id" bigint NOT NULL,
	"hour_utc" timestamp with time zone NOT NULL,
	"sample_count" integer NOT NULL,
	"bins" smallint[],
	"counts" integer[],
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"mean" double precision NOT NULL,
	CONSTRAINT "observation_rollup_hourly_series_id_hour_utc_pk" PRIMARY KEY("series_id","hour_utc")
);
--> statement-breakpoint
CREATE TABLE "conditions"."observation_rollup_progress" (
	"period" text PRIMARY KEY NOT NULL,
	"finalized_before" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conditions"."observation_rollup_daily" ADD CONSTRAINT "observation_rollup_daily_series_fk" FOREIGN KEY ("series_id") REFERENCES "conditions"."observation_latest"("series_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."observation_rollup_hourly" ADD CONSTRAINT "observation_rollup_hourly_series_fk" FOREIGN KEY ("series_id") REFERENCES "conditions"."observation_latest"("series_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_observation_latest_geom" ON "conditions"."observation_latest" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_observation_latest_property" ON "conditions"."observation_latest" USING btree ("property");--> statement-breakpoint
CREATE INDEX "idx_observation_latest_property_text" ON "conditions"."observation_latest" USING btree ("property","value_text");--> statement-breakpoint
CREATE INDEX "idx_observation_latest_component" ON "conditions"."observation_latest" USING btree ("feature_id","component_key");--> statement-breakpoint
CREATE INDEX "idx_observation_latest_fuel_price" ON "conditions"."observation_latest" USING btree ("value_money") WHERE "conditions"."observation_latest"."property" = 'fuel.price';--> statement-breakpoint
CREATE INDEX "idx_observation_latest_expires" ON "conditions"."observation_latest" USING btree ("expires_at") WHERE "conditions"."observation_latest"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_observation_rollup_daily_day" ON "conditions"."observation_rollup_daily" USING btree ("day_utc");--> statement-breakpoint
CREATE INDEX "idx_observation_rollup_hourly_hour" ON "conditions"."observation_rollup_hourly" USING btree ("hour_utc");