CREATE TABLE "conditions"."osm_road" (
	"way_id" bigint PRIMARY KEY NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	"highway" text NOT NULL,
	"oneway" boolean DEFAULT false NOT NULL,
	"ref" text,
	"name" text,
	"maxspeed_kph" double precision,
	"region" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."road_segment" (
	"segment_id" text PRIMARY KEY NOT NULL,
	"way_id" bigint NOT NULL,
	"dir" text NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	"highway" text NOT NULL,
	"ref" text,
	"length_m" double precision NOT NULL,
	"min_zoom" smallint NOT NULL,
	"free_flow_kph" double precision,
	"openlr" text,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."sensor_segment" (
	"sensor_key" text PRIMARY KEY NOT NULL,
	"segment_id" text NOT NULL,
	"fraction" double precision NOT NULL,
	"offset_m" double precision NOT NULL,
	"bearing_deg" double precision,
	"matched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_osm_road_geom" ON "conditions"."osm_road" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_osm_road_highway" ON "conditions"."osm_road" USING btree ("highway");--> statement-breakpoint
CREATE INDEX "idx_osm_road_ref" ON "conditions"."osm_road" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "idx_road_segment_geom" ON "conditions"."road_segment" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_road_segment_way" ON "conditions"."road_segment" USING btree ("way_id");--> statement-breakpoint
CREATE INDEX "idx_road_segment_minzoom" ON "conditions"."road_segment" USING btree ("min_zoom");--> statement-breakpoint
CREATE INDEX "idx_sensor_segment_segment" ON "conditions"."sensor_segment" USING btree ("segment_id");