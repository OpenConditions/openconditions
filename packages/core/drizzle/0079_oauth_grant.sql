CREATE TABLE "conditions"."oauth_grant" (
	"grant_key" text PRIMARY KEY NOT NULL,
	"refresh_token" text NOT NULL,
	"refresh_issued_at" timestamp with time zone NOT NULL,
	"access_token" text,
	"access_expires_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
