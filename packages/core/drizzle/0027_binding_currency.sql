CREATE TABLE "conditions"."binding_queue" (
	"observation_id" text PRIMARY KEY NOT NULL,
	"observation_revision" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."road_graph_state" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"generation" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"regions" jsonb NOT NULL,
	"highway_classes" jsonb NOT NULL,
	"pbf_provenance" jsonb NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "road_graph_state_singleton" CHECK ("conditions"."road_graph_state"."singleton" IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "conditions"."observation_binding" ADD COLUMN "observation_revision" text;--> statement-breakpoint
ALTER TABLE "conditions"."observation_binding" ADD COLUMN "graph_generation" text;--> statement-breakpoint
ALTER TABLE "conditions"."osm_road" ADD COLUMN "import_config_hash" text;--> statement-breakpoint
ALTER TABLE "conditions"."osm_road" ADD COLUMN "import_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "conditions"."binding_queue" ADD CONSTRAINT "binding_queue_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "conditions"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_binding_queue_due" ON "conditions"."binding_queue" USING btree ("next_attempt_at");
