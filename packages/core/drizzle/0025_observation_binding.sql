CREATE TABLE "conditions"."observation_binding" (
	"observation_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"confidence" double precision,
	"direction_mode" text DEFAULT 'single' NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"alternative_confidence" double precision,
	"reason" text,
	"resolver_version" text NOT NULL,
	"geom_hash" text NOT NULL,
	"bound_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."observation_segment" (
	"observation_id" text NOT NULL,
	"seq" smallint NOT NULL,
	"segment_id" text NOT NULL,
	"way_id" bigint NOT NULL,
	"dir" text NOT NULL,
	"start_fraction" double precision NOT NULL,
	"end_fraction" double precision NOT NULL,
	CONSTRAINT "observation_segment_observation_id_seq_pk" PRIMARY KEY("observation_id","seq")
);
--> statement-breakpoint
ALTER TABLE "conditions"."observation_binding" ADD CONSTRAINT "observation_binding_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "conditions"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."observation_segment" ADD CONSTRAINT "observation_segment_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "conditions"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_observation_binding_status" ON "conditions"."observation_binding" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_observation_segment_segment" ON "conditions"."observation_segment" USING btree ("segment_id");