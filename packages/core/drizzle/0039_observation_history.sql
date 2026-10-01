-- Custom SQL migration file, put your code below! --
-- The compact observation history: one row per reading of a series in
-- observation_latest, holding only what varies between readings. Partitioned
-- first by the series' retention class (a property's raw-history days, 0 for
-- keep-everything), then by the reading's start, so retention drops whole
-- partitions. The ingest service creates and drops the partitions; a row with
-- no partition is an error, never a default partition.
CREATE TABLE "conditions"."observation" (
	"series_id" bigint NOT NULL,
	"retention_days" smallint NOT NULL,
	"phenomenon_start" timestamp with time zone NOT NULL,
	"phenomenon_end" timestamp with time zone,
	"issued_at" timestamp with time zone DEFAULT '-infinity' NOT NULL,
	"result_time" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"fetched_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"temporality" text NOT NULL,
	"aggregation" text NOT NULL,
	"value_num" double precision,
	"value_money" numeric(14, 4),
	"value_text" text,
	"value_json" jsonb,
	"quality" jsonb,
	"baseline" jsonb,
	"fetch_id" bigint,
	"raw_part" smallint,
	"extra" jsonb,
	CONSTRAINT "observation_pk" PRIMARY KEY ("series_id", "phenomenon_start", "issued_at", "retention_days"),
	CONSTRAINT "observation_retention_days_nonneg" CHECK ("retention_days" >= 0)
) PARTITION BY LIST ("retention_days");
--> statement-breakpoint
CREATE INDEX "idx_observation_start" ON "conditions"."observation" USING btree ("phenomenon_start");
--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" SET (fillfactor = 70);
