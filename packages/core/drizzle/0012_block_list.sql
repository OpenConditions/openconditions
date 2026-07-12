CREATE TABLE "conditions"."block_list" (
	"key_id" text PRIMARY KEY NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL
);
