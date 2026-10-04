CREATE TABLE "conditions"."on_demand_fetch" (
	"source_id" text NOT NULL,
	"cell" text NOT NULL,
	"fetched_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" text NOT NULL,
	"retry_at" timestamp with time zone,
	"claimed_until" timestamp with time zone,
	CONSTRAINT "on_demand_fetch_source_id_cell_pk" PRIMARY KEY("source_id","cell"),
	CONSTRAINT "on_demand_fetch_status_enum" CHECK ("conditions"."on_demand_fetch"."status" IN ('pending','fresh','failed'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."on_demand_quota" (
	"source_id" text PRIMARY KEY NOT NULL,
	"tokens" real NOT NULL,
	"refilled_at" timestamp with time zone NOT NULL,
	"day" date NOT NULL,
	"day_count" integer NOT NULL
);
--> statement-breakpoint
DROP INDEX "conditions"."idx_observation_latest_source";--> statement-breakpoint
DROP INDEX "conditions"."idx_feature_source";--> statement-breakpoint
DROP INDEX "conditions"."idx_offer_source";--> statement-breakpoint
DROP INDEX "conditions"."idx_situation_source";--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ADD COLUMN "fused_sources" text[];--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ADD COLUMN "fused_public" boolean;--> statement-breakpoint
ALTER TABLE "conditions"."feature" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."offer" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."situation" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."segment_profile" ADD COLUMN "contributing" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "restricted_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "fusion_restricted" boolean;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "fusion_tier" text;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "fusion_licenses" text;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "federation_restricted" boolean;--> statement-breakpoint
ALTER TABLE "conditions"."source" ADD COLUMN "federation_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_observation_latest_source" ON "conditions"."observation_latest" USING btree ("source_id","series_id");--> statement-breakpoint
CREATE INDEX "idx_feature_source" ON "conditions"."feature" USING btree ("source_id","id");--> statement-breakpoint
CREATE INDEX "idx_offer_source" ON "conditions"."offer" USING btree ("source_id","id");--> statement-breakpoint
CREATE INDEX "idx_situation_source" ON "conditions"."situation" USING btree ("source_id","id");