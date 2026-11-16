CREATE TABLE "conditions"."federation_journal" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"epoch" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"seen_xid" "xid8" NOT NULL,
	"timeline_id" integer,
	CONSTRAINT "federation_journal_single_row" CHECK ("conditions"."federation_journal"."singleton")
);
--> statement-breakpoint
ALTER TABLE "conditions"."federation_peer_cursor" ADD COLUMN "journal_epoch" text;--> statement-breakpoint
ALTER TABLE "conditions"."federation_peer_cursor" ADD COLUMN "cursor_reset_at" timestamp with time zone;--> statement-breakpoint
-- The journal that exists is adopted as the first epoch: nothing is emptied.
-- The timeline is filled in by the federation service once it can read it.
INSERT INTO "conditions"."federation_journal" (epoch, started_at, seen_xid, timeline_id)
VALUES (gen_random_uuid(), now(), pg_snapshot_xmax(pg_current_snapshot()), NULL);
