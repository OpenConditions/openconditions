CREATE TABLE "conditions"."raw_payload" (
	"source_id" text NOT NULL,
	"hash" text NOT NULL,
	"url_key" text NOT NULL,
	"fetch_id" bigint,
	"media_type" text,
	"bytes_raw" bigint NOT NULL,
	"bytes_stored" bigint NOT NULL,
	"first_fetched_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"tier" text NOT NULL,
	"pinned_reason" text,
	"storage_key" text NOT NULL,
	"base_hash" text,
	"evicted_at" timestamp with time zone,
	CONSTRAINT "raw_payload_pk" PRIMARY KEY("source_id","hash"),
	CONSTRAINT "raw_payload_tier_enum" CHECK ("tier" IN ('situation', 'observation', 'reference', 'hot'))
);
--> statement-breakpoint
ALTER TABLE "conditions"."source_poll_attempt" ALTER COLUMN "finished_at" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_raw_payload_source_time" ON "conditions"."raw_payload" USING btree ("source_id","first_fetched_at");--> statement-breakpoint
CREATE INDEX "idx_raw_payload_tier_seen" ON "conditions"."raw_payload" USING btree ("tier","last_seen_at") WHERE "conditions"."raw_payload"."evicted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_raw_payload_base" ON "conditions"."raw_payload" USING btree ("source_id","base_hash") WHERE "conditions"."raw_payload"."base_hash" IS NOT NULL;