-- The reverse direction of legacy one-way roads was never persisted. A default
-- cannot reconstruct it; withhold graph-derived route effects until a complete
-- import and rebuild records the new direction-aware import provenance.
UPDATE "conditions"."road_graph_state" SET "status" = 'rebuilding' WHERE "singleton";
--> statement-breakpoint
UPDATE "conditions"."record_binding" SET "status" = 'obsolete';
