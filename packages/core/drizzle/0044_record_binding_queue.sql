CREATE TABLE "conditions"."binding_queue" (
	"record_class" text NOT NULL,
	"record_id" text NOT NULL,
	"effect_id" text DEFAULT '' NOT NULL,
	"record_revision" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "binding_queue_record_class_record_id_effect_id_pk" PRIMARY KEY("record_class","record_id","effect_id")
);
--> statement-breakpoint
CREATE INDEX "idx_binding_queue_due" ON "conditions"."binding_queue" USING btree ("next_attempt_at");