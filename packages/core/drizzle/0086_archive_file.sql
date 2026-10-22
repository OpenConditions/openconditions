CREATE TABLE "conditions"."archive_file" (
	"record_class" text PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"built_at" timestamp with time zone NOT NULL
);
