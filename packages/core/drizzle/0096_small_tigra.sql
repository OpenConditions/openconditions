CREATE TABLE "conditions"."nsw_rfs_clock" (
	"source_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"sent" text NOT NULL,
	"published" text NOT NULL,
	"content" text NOT NULL,
	"expiry" text NOT NULL,
	CONSTRAINT "nsw_rfs_clock_source_id_incident_id_pk" PRIMARY KEY("source_id","incident_id")
);
