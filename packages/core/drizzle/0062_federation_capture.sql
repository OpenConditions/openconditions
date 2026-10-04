-- What the outbox capture journals of this instance's records, and what it
-- erases of a restricted source's. drizzle-kit cannot model functions or
-- triggers, so the DDL is authored here.
--
-- A restricted source's records never leave the instance, as an on-demand
-- answer or a peer's record does not: the capture skips their creates and
-- updates, since none of their content may be journalled.
CREATE FUNCTION "conditions".federation_may_carry(rec jsonb, access_mode text, src text)
RETURNS boolean AS $$
  SELECT "conditions".federation_is_own(rec, access_mode)
     AND NOT EXISTS (
       SELECT 1 FROM "conditions"."source" s WHERE s.id = src AND s.restricted)
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
-- A situation's journalled snapshot and priority, shared by the capture and
-- the boot's reconcile of a source turned public, so both journal the same
-- entry.
CREATE FUNCTION "conditions".federation_situation_snapshot(s "conditions"."situation")
RETURNS jsonb AS $$
  SELECT CASE WHEN s.evidence_state IS NULL THEN s.record
    ELSE s.record || jsonb_build_object('evidence', jsonb_build_object(
      'state', s.evidence_state,
      'confidenceScore', s.confidence_score,
      'routingEligible', s.routing_eligible,
      'corroborations', s.corroborations)) END
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
-- Priority: what closes a road, all its lanes, or is an incident.
CREATE FUNCTION "conditions".federation_situation_priority(kind text, rec jsonb)
RETURNS boolean AS $$
  SELECT kind = 'incident' OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(rec -> 'effects', '[]'::jsonb)) e
    WHERE e ->> 'kind' = 'closure'
       OR (e ->> 'kind' = 'lane_restriction' AND e ->> 'vehicleImpact' = 'all_lanes_closed'))
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
-- Whether a peer may hold this instance's record `rec_id`, of a source now
-- restricted: it has outbox entries, or a subscription wants its class and
-- it was stored by the time its source last turned restricted (entries a
-- peer pulled while the source was public may since have been pruned). A
-- record stored since its source turned restricted, or of a source
-- restricted since it was added, never reached a peer: nothing of it, not
-- even a delete, is journalled.
CREATE FUNCTION "conditions".federation_was_shared(
  cls text, rec_id text, rec_created_at timestamptz, src text)
RETURNS boolean AS $$
  SELECT EXISTS (
           SELECT 1 FROM "conditions"."federation_outbox" o
            WHERE o.record_class = cls AND o.record_id = rec_id)
      OR ("conditions".federation_wants(cls) AND EXISTS (
           SELECT 1 FROM "conditions"."source" s
            WHERE s.id = src AND (NOT s.restricted OR rec_created_at <= s.restricted_since)))
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
-- An erasure of a restricted source's own record still erases what a peer
-- may hold of it, and goes out as a delete (which carries no content), so a
-- subscriber erases its copy too; a record no peer can hold journals nothing.
CREATE OR REPLACE FUNCTION "conditions".federation_situation_capture() RETURNS trigger AS $$
BEGIN
  IF NOT "conditions".federation_may_carry(NEW.record, NEW.access_mode, NEW.source_id) THEN
    IF TG_OP = 'UPDATE' AND NEW.tombstone_reason = 'rights_revoked'
       AND OLD.tombstone_reason IS DISTINCT FROM 'rights_revoked'
       AND "conditions".federation_is_own(NEW.record, NEW.access_mode)
       AND "conditions".federation_was_shared('situation', NEW.id, NEW.created_at, NEW.source_id) THEN
      PERFORM "conditions".federation_journal_tombstone('situation', NEW);
    END IF;
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
  INSERT INTO "conditions"."federation_outbox"
    (operation, record_class, record_id, canonical_id, kind, domain, priority, snapshot)
  VALUES (
    CASE WHEN TG_OP = 'INSERT' OR OLD.tombstoned_at IS NOT NULL THEN 'create' ELSE 'update' END,
    'situation', NEW.id, NEW.canonical_id, NEW.kind, NEW.domain,
    "conditions".federation_situation_priority(NEW.kind, NEW.record),
    "conditions".federation_situation_snapshot(NEW));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "conditions".federation_record_capture() RETURNS trigger AS $$
BEGIN
  IF NOT "conditions".federation_may_carry(NEW.record, NEW.access_mode, NEW.source_id) THEN
    IF TG_OP = 'UPDATE' AND NEW.tombstone_reason = 'rights_revoked'
       AND OLD.tombstone_reason IS DISTINCT FROM 'rights_revoked'
       AND "conditions".federation_is_own(NEW.record, NEW.access_mode)
       AND "conditions".federation_was_shared(TG_TABLE_NAME, NEW.id, NEW.created_at, NEW.source_id) THEN
      PERFORM "conditions".federation_journal_tombstone(TG_TABLE_NAME, NEW);
    END IF;
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
-- Fused rows, full and public, stay on the instance that computed them.
CREATE OR REPLACE FUNCTION "conditions".federation_observation_capture() RETURNS trigger AS $$
DECLARE
  rec jsonb;
BEGIN
  -- Cheapest first: the template is out of line, and a flow poll updates a
  -- hundred thousand rows no subscription asks for.
  IF NEW.source_id IN ('@fused', '@fused-public', 'crowd')
     OR NOT EXISTS (
       SELECT 1 FROM "conditions"."federation_subscription" s
       WHERE s.filter -> 'properties' ? NEW.property
         AND (NOT (s.filter ? 'classes') OR s.filter -> 'classes' ? 'observation')) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.reading = NEW.reading AND OLD.template_hash = NEW.template_hash THEN
    RETURN NULL;
  END IF;
  IF NOT "conditions".federation_may_carry(NEW.template, NEW.access_mode, NEW.source_id) THEN
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
