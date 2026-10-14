CREATE TABLE "conditions"."report_refusal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_key_id" text NOT NULL,
	"cell" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_report_refusal_actor" ON "conditions"."report_refusal" USING btree ("actor_key_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_report_refusal_occurred" ON "conditions"."report_refusal" USING btree ("occurred_at");