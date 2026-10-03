-- The latest readings are about to keep only what varies per reading, next to
-- their series template. No instance holds data yet, so the rows of the old
-- shape go rather than being converted, with the history keyed to them; the
-- next poll writes every series again.
DELETE FROM "conditions"."observation";
--> statement-breakpoint
DELETE FROM "conditions"."observation_latest";
