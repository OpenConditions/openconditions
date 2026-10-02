CREATE TABLE "conditions"."record_binding" (
	"record_class" text NOT NULL,
	"record_id" text NOT NULL,
	"effect_id" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"confidence" double precision,
	"direction_mode" text NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"alternative_confidence" double precision,
	"reason" text,
	"resolver_version" text NOT NULL,
	"geom_hash" text NOT NULL,
	"record_revision" integer NOT NULL,
	"graph_generation" text,
	"bound_at" timestamp with time zone NOT NULL,
	CONSTRAINT "record_binding_record_class_record_id_effect_id_pk" PRIMARY KEY("record_class","record_id","effect_id"),
	CONSTRAINT "record_binding_record_class_enum" CHECK ("record_class" IN ('feature', 'situation', 'observation', 'offer'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."record_segment" (
	"record_class" text NOT NULL,
	"record_id" text NOT NULL,
	"effect_id" text DEFAULT '' NOT NULL,
	"seq" smallint NOT NULL,
	"segment_id" text NOT NULL,
	"way_id" bigint NOT NULL,
	"dir" text NOT NULL,
	"start_fraction" double precision NOT NULL,
	"end_fraction" double precision NOT NULL,
	CONSTRAINT "record_segment_record_class_record_id_effect_id_seq_pk" PRIMARY KEY("record_class","record_id","effect_id","seq")
);
--> statement-breakpoint
CREATE INDEX "idx_record_binding_status" ON "conditions"."record_binding" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_record_segment_segment" ON "conditions"."record_segment" USING btree ("segment_id");