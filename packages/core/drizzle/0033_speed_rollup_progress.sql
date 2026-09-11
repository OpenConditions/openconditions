CREATE TABLE "conditions"."speed_rollup_progress" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"finalized_before" timestamp with time zone NOT NULL,
	CONSTRAINT "speed_rollup_progress_singleton" CHECK ("conditions"."speed_rollup_progress"."id" = 1)
);
