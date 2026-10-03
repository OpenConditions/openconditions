-- A latest row keeps its reading inline and its series template out of
-- line: a row grows past the tuple target only by its template (about a
-- kilobyte), whose storage EXTERNAL moves it to the TOAST table, and an
-- update that keeps it carries only its pointer; the reading's storage MAIN
-- keeps it in the row, so an update writes no TOAST entry. Rows of about a
-- kilobyte leave room on their page for heap-only updates. A flow source
-- rewrites tens of thousands of readings a minute; the template changes when
-- the site does. drizzle-kit cannot model storage parameters or functions, so
-- the DDL is authored here.
ALTER TABLE "conditions"."observation_latest" ALTER COLUMN "template" SET STORAGE EXTERNAL;
--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ALTER COLUMN "reading" SET STORAGE MAIN;
--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" SET (toast_tuple_target = 1200, fillfactor = 50);
--> statement-breakpoint
-- The stored observation a latest row holds: its series template with the
-- reading's own fields, provenance merged (`recordOf` in code).
CREATE FUNCTION "conditions".observation_record(template jsonb, reading jsonb) RETURNS jsonb AS $$
  SELECT (template - 'namespace' - 'provenance') || (reading - 'provenance')
      || jsonb_build_object('provenance',
           (template -> 'provenance') || COALESCE(reading -> 'provenance', '{}'::jsonb))
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "conditions".federation_observation_capture() RETURNS trigger AS $$
DECLARE
  rec jsonb;
BEGIN
  -- Cheapest first: the template is out of line, and a flow poll updates a
  -- hundred thousand rows no subscription asks for.
  IF NEW.source_id IN ('@fused', 'crowd')
     OR NOT EXISTS (
       SELECT 1 FROM "conditions"."federation_subscription" s
       WHERE s.filter -> 'properties' ? NEW.property
         AND (NOT (s.filter ? 'classes') OR s.filter -> 'classes' ? 'observation')) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.reading = NEW.reading AND OLD.template_hash = NEW.template_hash THEN
    RETURN NULL;
  END IF;
  IF NOT "conditions".federation_is_own(NEW.template, NEW.access_mode) THEN
    RETURN NULL;
  END IF;
  rec := "conditions".observation_record(NEW.template, NEW.reading);
  INSERT INTO "conditions"."federation_outbox"
    (operation, record_class, record_id, canonical_id, kind, domain, property, snapshot)
  VALUES (
    CASE TG_OP WHEN 'INSERT' THEN 'create' ELSE 'update' END,
    'observation', rec ->> 'id', rec ->> 'canonicalId', 'observation',
    rec ->> 'domain', NEW.property, rec);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
