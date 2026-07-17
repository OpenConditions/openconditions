-- Gate the outbox capture (migrations 0014, 0018) on there being a subscriber.
--
-- The capture trigger journalled a full row snapshot for EVERY observation
-- mutation unconditionally. The ingest rewrites its feed observations
-- continuously (~20M mutations/day), so on an instance with no federation peers
-- this wrote ~1.4M rows/hour (~1.9 KB each) that nothing would ever read, while
-- the retention floor in pruneOutbox (Tier-1 backfill window + margin) correctly
-- refused to prune them for weeks. It filled the disk and took Postgres down.
--
-- Journalling now starts when a peer actually subscribes. TRADE-OFF: a peer that
-- subscribes later cannot backfill mutations from before its subscription — the
-- journal simply does not exist for that period. That is the intended exchange:
-- Tier-1 backfill is bounded anyway, and the alternative is unbounded disk
-- growth to serve nobody. federation_subscription is tiny and stays hot in
-- cache, so the added per-row EXISTS is far cheaper than the INSERT it avoids.
--
-- Everything else (payload shape, reporter stripping, tombstone reasons, the
-- archived->delete mapping) is carried over from 0018 UNCHANGED. CREATE OR
-- REPLACE keeps the existing triggers bound to this same function name;
-- drizzle-kit cannot model functions, so the DDL is authored here (as 0014/0018).
CREATE OR REPLACE FUNCTION "conditions".federation_outbox_capture() RETURNS trigger AS $$
DECLARE
  payload jsonb;
BEGIN
  -- No subscriber, no journal. AFTER-trigger return values are ignored; OLD/NEW
  -- is returned to match the shape of the paths below.
  IF NOT EXISTS (SELECT 1 FROM "conditions"."federation_subscription") THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- A bare DELETE with no reason is a TTL/expiry sweep -> 'expired'.
    INSERT INTO "conditions"."federation_outbox" (object_id, operation, canonical_id, payload_snapshot)
    VALUES (OLD.id, 'delete', OLD.canonical_id,
            jsonb_build_object('id', OLD.id, 'canonical_id', OLD.canonical_id, 'tombstone', true,
                               'reason', COALESCE(OLD.tombstone_reason, 'expired')));
    RETURN OLD;
  END IF;
  -- A soft tombstone: the reviewer/GDPR/operator path scrubs + archives the row
  -- (status -> 'archived') keeping the audit ledger. It must propagate as a
  -- federation DELETION, not a content update, so emit a signed tombstone marker
  -- with the row's reason instead of the 'update' payload.
  IF TG_OP = 'UPDATE' AND NEW.status = 'archived' AND OLD.status <> 'archived' THEN
    INSERT INTO "conditions"."federation_outbox" (object_id, operation, canonical_id, payload_snapshot)
    VALUES (NEW.id, 'delete', NEW.canonical_id,
            jsonb_build_object('id', NEW.id, 'canonical_id', NEW.canonical_id, 'tombstone', true,
                               'reason', COALESCE(NEW.tombstone_reason, 'deleted_by_source')));
    RETURN NEW;
  END IF;
  payload := (to_jsonb(NEW) - 'geom')
    || jsonb_build_object('geom', ST_AsGeoJSON(NEW.geom)::jsonb);
  IF payload -> 'origin' ? 'reporter' THEN
    payload := jsonb_set(payload, '{origin}', (payload -> 'origin') - 'reporter');
  END IF;
  INSERT INTO "conditions"."federation_outbox" (object_id, operation, canonical_id, payload_snapshot)
  VALUES (NEW.id, CASE TG_OP WHEN 'INSERT' THEN 'create' ELSE 'update' END, NEW.canonical_id, payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Re-enable the capture triggers: prod had them administratively disabled to
-- stop the disk filling. With the gate in the function they are safe to leave
-- enabled, and ENABLE is a no-op for triggers that are already enabled.
ALTER TABLE "conditions"."observations" ENABLE TRIGGER federation_outbox_capture_insert;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ENABLE TRIGGER federation_outbox_capture_update;--> statement-breakpoint
ALTER TABLE "conditions"."observations" ENABLE TRIGGER federation_outbox_capture_delete;
