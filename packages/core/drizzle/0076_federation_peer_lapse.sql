CREATE TABLE "conditions"."federation_lapsed_copy" (
	"record_class" text NOT NULL,
	"record_id" text NOT NULL,
	"peer_instance_id" text NOT NULL,
	"source_id" text NOT NULL,
	"revision" integer NOT NULL,
	"lapsed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "federation_lapsed_copy_record_class_record_id_pk" PRIMARY KEY("record_class","record_id")
);
--> statement-breakpoint
ALTER TABLE "conditions"."federation_source_receipt" ADD COLUMN "liveness_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_federation_lapsed_copy_source" ON "conditions"."federation_lapsed_copy" USING btree ("peer_instance_id","source_id");