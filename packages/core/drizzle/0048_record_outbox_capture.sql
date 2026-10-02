-- Journals this instance's own records into the federation outbox, in the
-- writing transaction. Only records a peer may hold are journalled: a record
-- that reached this instance from a peer carries an origin chain and is that
-- peer's to federate, and an on-demand answer or a fused row never leaves
-- the instance. Journalling is gated on a subscription that wants the class
-- (no `classes` in its filter, or `classes` naming it); observations only for
-- a subscription naming the property, since flow series change by the tens of
-- thousands every minute. A tombstone journals a `delete` with its reason,
-- also when no subscription wants the class any more but the record has
-- entries a peer may have pulled; an erasure (`rights_revoked`) also removes
-- the record's earlier entries, so nothing of it can be served again.
-- drizzle-kit cannot model functions or triggers, so the DDL is authored here.
CREATE FUNCTION "conditions".federation_wants(cls text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "conditions"."federation_subscription" s
    WHERE NOT (s.filter ? 'classes') OR s.filter -> 'classes' ? cls)
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE FUNCTION "conditions".federation_is_own(rec jsonb, access_mode text) RETURNS boolean AS $$
  SELECT access_mode <> 'on_demand'
     AND jsonb_array_length(COALESCE(rec #> '{provenance,originChain}', '[]'::jsonb)) = 0
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
CREATE FUNCTION "conditions".federation_journal_tombstone(cls text, rec record) RETURNS void AS $$
BEGIN
  IF NOT "conditions".federation_wants(cls) AND NOT EXISTS (
      SELECT 1 FROM "conditions"."federation_outbox"
      WHERE record_class = cls AND record_id = rec.id) THEN
    RETURN;
  END IF;
  INSERT INTO "conditions"."federation_outbox"
    (operation, record_class, record_id, canonical_id, kind, domain, tombstone_reason)
  VALUES ('delete', cls, rec.id, rec.canonical_id, rec.kind, rec.domain, rec.tombstone_reason);
  IF rec.tombstone_reason = 'rights_revoked' THEN
    DELETE FROM "conditions"."federation_outbox"
    WHERE record_class = cls AND record_id = rec.id AND operation <> 'delete';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "conditions".federation_situation_capture() RETURNS trigger AS $$
DECLARE
  snapshot jsonb;
BEGIN
  IF NOT "conditions".federation_is_own(NEW.record, NEW.access_mode) THEN
    RETURN NULL;
  END IF;
  IF NEW.tombstoned_at IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND (OLD.tombstoned_at IS NULL
        OR OLD.tombstone_reason IS DISTINCT FROM NEW.tombstone_reason) THEN
      PERFORM "conditions".federation_journal_tombstone('situation', NEW);
    END IF;
    RETURN NULL;
  END IF;
  IF NOT "conditions".federation_wants('situation') THEN
    RETURN NULL;
  END IF;
  -- A change is a new revision, or new evidence on a crowd report (whose
  -- lifetime is part of its evidence). An expiry a feed poll slides along
  -- changes neither.
  IF TG_OP = 'UPDATE' AND OLD.tombstoned_at IS NULL AND OLD.revision = NEW.revision
     AND OLD.evidence_state IS NOT DISTINCT FROM NEW.evidence_state
     AND OLD.confidence_score IS NOT DISTINCT FROM NEW.confidence_score
     AND OLD.routing_eligible = NEW.routing_eligible
     AND OLD.corroborations = NEW.corroborations
     AND (NEW.origin <> 'crowd' OR OLD.expires_at IS NOT DISTINCT FROM NEW.expires_at) THEN
    RETURN NULL;
  END IF;
  snapshot := NEW.record;
  IF NEW.evidence_state IS NOT NULL THEN
    snapshot := snapshot || jsonb_build_object('evidence', jsonb_build_object(
      'state', NEW.evidence_state,
      'confidenceScore', NEW.confidence_score,
      'routingEligible', NEW.routing_eligible,
      'corroborations', NEW.corroborations));
  END IF;
  INSERT INTO "conditions"."federation_outbox"
    (operation, record_class, record_id, canonical_id, kind, domain, priority, snapshot)
  VALUES (
    CASE WHEN TG_OP = 'INSERT' OR OLD.tombstoned_at IS NOT NULL THEN 'create' ELSE 'update' END,
    'situation', NEW.id, NEW.canonical_id, NEW.kind, NEW.domain,
    -- Priority: what closes a road, all its lanes, or is an incident.
    NEW.kind = 'incident' OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.record -> 'effects', '[]'::jsonb)) e
      WHERE e ->> 'kind' = 'closure'
         OR (e ->> 'kind' = 'lane_restriction' AND e ->> 'vehicleImpact' = 'all_lanes_closed')),
    snapshot);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "conditions".federation_record_capture() RETURNS trigger AS $$
BEGIN
  IF NOT "conditions".federation_is_own(NEW.record, NEW.access_mode) THEN
    RETURN NULL;
  END IF;
  IF NEW.tombstoned_at IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND (OLD.tombstoned_at IS NULL
        OR OLD.tombstone_reason IS DISTINCT FROM NEW.tombstone_reason) THEN
      PERFORM "conditions".federation_journal_tombstone(TG_TABLE_NAME, NEW);
    END IF;
    RETURN NULL;
  END IF;
  IF NOT "conditions".federation_wants(TG_TABLE_NAME) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.tombstoned_at IS NULL AND OLD.revision = NEW.revision THEN
    RETURN NULL;
  END IF;
  INSERT INTO "conditions"."federation_outbox"
    (operation, record_class, record_id, canonical_id, kind, domain, snapshot)
  VALUES (
    CASE WHEN TG_OP = 'INSERT' OR OLD.tombstoned_at IS NOT NULL THEN 'create' ELSE 'update' END,
    TG_TABLE_NAME, NEW.id, NEW.canonical_id, NEW.kind, NEW.domain, NEW.record);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "conditions".federation_observation_capture() RETURNS trigger AS $$
BEGIN
  IF NEW.source_id = '@fused' OR NOT "conditions".federation_is_own(NEW.record, NEW.access_mode)
     OR NOT EXISTS (
       SELECT 1 FROM "conditions"."federation_subscription" s
       WHERE s.filter -> 'properties' ? NEW.property
         AND (NOT (s.filter ? 'classes') OR s.filter -> 'classes' ? 'observation')) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.record = NEW.record THEN
    RETURN NULL;
  END IF;
  INSERT INTO "conditions"."federation_outbox"
    (operation, record_class, record_id, canonical_id, kind, domain, property, snapshot)
  VALUES (
    CASE TG_OP WHEN 'INSERT' THEN 'create' ELSE 'update' END,
    'observation', NEW.record ->> 'id', NEW.record ->> 'canonicalId', 'observation',
    NEW.record ->> 'domain', NEW.property, NEW.record);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER federation_capture AFTER INSERT OR UPDATE ON "conditions"."situation"
  FOR EACH ROW EXECUTE FUNCTION "conditions".federation_situation_capture();
--> statement-breakpoint
CREATE TRIGGER federation_capture AFTER INSERT OR UPDATE ON "conditions"."feature"
  FOR EACH ROW EXECUTE FUNCTION "conditions".federation_record_capture();
--> statement-breakpoint
CREATE TRIGGER federation_capture AFTER INSERT OR UPDATE ON "conditions"."offer"
  FOR EACH ROW EXECUTE FUNCTION "conditions".federation_record_capture();
--> statement-breakpoint
CREATE TRIGGER federation_capture AFTER INSERT OR UPDATE ON "conditions"."observation_latest"
  FOR EACH ROW EXECUTE FUNCTION "conditions".federation_observation_capture();
