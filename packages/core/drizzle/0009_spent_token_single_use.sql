CREATE TABLE "conditions"."spent_token" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"spent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_spent_token_spent_at" ON "conditions"."spent_token" USING btree ("spent_at");