CREATE TABLE "conditions"."jma_budget" (
	"egress" text NOT NULL,
	"day" text NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "jma_budget_egress_day_pk" PRIMARY KEY("egress","day"),
	CONSTRAINT "jma_budget_nonnegative" CHECK ("conditions"."jma_budget"."used" >= 0 AND "conditions"."jma_budget"."reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conditions"."jma_download" (
	"url" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
