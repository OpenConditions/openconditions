CREATE TABLE "conditions"."segment_observation" (
	"segment_id" text NOT NULL,
	"source" text NOT NULL,
	"source_tier" text NOT NULL,
	"current_kph" double precision,
	"free_flow_kph" double precision,
	"speed_ratio" double precision,
	"los" text NOT NULL,
	"confidence" double precision NOT NULL,
	"sample_count" integer,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "segment_observation_segment_id_source_pk" PRIMARY KEY("segment_id","source")
);
--> statement-breakpoint
CREATE TABLE "conditions"."segment_speed" (
	"segment_id" text PRIMARY KEY NOT NULL,
	"current_kph" double precision,
	"free_flow_kph" double precision,
	"speed_ratio" double precision,
	"los" text NOT NULL,
	"confidence" text NOT NULL,
	"source_tier" text,
	"contributing" text[],
	"is_estimated" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_segment_observation_segment" ON "conditions"."segment_observation" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "idx_segment_speed_los" ON "conditions"."segment_speed" USING btree ("los");