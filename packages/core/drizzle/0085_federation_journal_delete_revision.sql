-- A journalled delete carries the revision the record ended at, so a
-- subscriber orders it against the record's changes: it ends a copy no newer
-- than that, and a change it received earlier by another channel stays.
-- drizzle-kit cannot model functions, so the DDL is authored here.
CREATE OR REPLACE FUNCTION "conditions".federation_journal_tombstone(cls text, rec record) RETURNS void AS $$
BEGIN
  IF NOT "conditions".federation_wants(cls) AND NOT EXISTS (
      SELECT 1 FROM "conditions"."federation_outbox"
      WHERE record_class = cls AND record_id = rec.id) THEN
    RETURN;
  END IF;
  INSERT INTO "conditions"."federation_outbox"
    (operation, record_class, record_id, canonical_id, kind, domain, tombstone_reason, revision)
  VALUES ('delete', cls, rec.id, rec.canonical_id, rec.kind, rec.domain, rec.tombstone_reason,
          rec.revision);
  IF rec.tombstone_reason = 'rights_revoked' THEN
    DELETE FROM "conditions"."federation_outbox"
    WHERE record_class = cls AND record_id = rec.id AND operation <> 'delete';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- The deletes already journalled: a record still ended ended at its current
-- revision; one live again ended at the last revision recorded by the time
-- of its delete.
UPDATE "conditions"."federation_outbox" o
   SET revision = CASE WHEN r.tombstoned_at IS NOT NULL THEN r.revision ELSE COALESCE(
         (SELECT max(h.revision) FROM "conditions"."situation_revision" h
           WHERE h.situation_id = r.id AND h.recorded_at <= o.created_at), r.revision) END
  FROM "conditions"."situation" r
 WHERE o.operation = 'delete' AND o.revision IS NULL
   AND o.record_class = 'situation' AND r.id = o.record_id;
--> statement-breakpoint
UPDATE "conditions"."federation_outbox" o
   SET revision = CASE WHEN r.tombstoned_at IS NOT NULL THEN r.revision ELSE COALESCE(
         (SELECT max(h.revision) FROM "conditions"."feature_revision" h
           WHERE h.feature_id = r.id AND h.recorded_at <= o.created_at), r.revision) END
  FROM "conditions"."feature" r
 WHERE o.operation = 'delete' AND o.revision IS NULL
   AND o.record_class = 'feature' AND r.id = o.record_id;
--> statement-breakpoint
UPDATE "conditions"."federation_outbox" o
   SET revision = CASE WHEN r.tombstoned_at IS NOT NULL THEN r.revision ELSE COALESCE(
         (SELECT max(h.revision) FROM "conditions"."offer_revision" h
           WHERE h.offer_id = r.id AND h.recorded_at <= o.created_at), r.revision) END
  FROM "conditions"."offer" r
 WHERE o.operation = 'delete' AND o.revision IS NULL
   AND o.record_class = 'offer' AND r.id = o.record_id;
