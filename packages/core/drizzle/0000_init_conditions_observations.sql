CREATE TABLE "conditions"."observations" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_format" text NOT NULL,
	"domain" text NOT NULL,
	"kind" text NOT NULL,
	"type" text,
	"subtype" text,
	"category" text,
	"severity" text,
	"severity_source" text,
	"headline" text,
	"description" text,
	"metric" text,
	"value" double precision,
	"level" text,
	"unit" text,
	"aggregation" text,
	"status" text DEFAULT 'active' NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	"subject" jsonb,
	"attributes" jsonb,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"schedule" jsonb,
	"confidence" text,
	"is_forecast" boolean DEFAULT false NOT NULL,
	"related_ids" jsonb,
	"origin" jsonb NOT NULL,
	"data_updated_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"is_stale" boolean DEFAULT false NOT NULL,
	"stale_after" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_geom" ON "conditions"."observations" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_domain" ON "conditions"."observations" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_dom_type" ON "conditions"."observations" USING btree ("domain","type");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_severity" ON "conditions"."observations" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_metric" ON "conditions"."observations" USING btree ("metric");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_valid_to" ON "conditions"."observations" USING btree ("valid_to");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_expires" ON "conditions"."observations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_subject" ON "conditions"."observations" USING gin ("subject");--> statement-breakpoint
CREATE INDEX "idx_conditions_obs_source" ON "conditions"."observations" USING btree ("source");