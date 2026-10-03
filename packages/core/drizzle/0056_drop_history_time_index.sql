-- History is read by series through the primary key (it leads with
-- series_id) and dropped a partition at a time; only the hourly rollup reads
-- by time alone, an hour of a day partition. Readings arrive roughly in time
-- order, so a block range index serves that read for a few pages a
-- partition, where a btree on time took about a fifth of every row's bytes.
DROP INDEX IF EXISTS "conditions"."idx_observation_start";
--> statement-breakpoint
CREATE INDEX "idx_observation_start_brin" ON "conditions"."observation" USING brin ("phenomenon_start");
