CREATE TABLE "conditions"."federation_instance_key" (
	"key_id" text PRIMARY KEY NOT NULL,
	"public_key" "bytea" NOT NULL,
	"private_key" "bytea" NOT NULL,
	"multibase" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
