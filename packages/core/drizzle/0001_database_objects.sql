-- What drizzle-kit cannot express: the partitioned observation history, the
-- storage settings of the latest readings, functions (among them the one
-- that grants the roles of OpenMapX's traffic tile and the contributions
-- service), triggers and the federation journal's first epoch. Everything
-- drizzle-kit can express is declared in the schema code and generated into
-- the baseline.
--
-- The compact observation history: one row per reading of a series in
-- observation_latest, holding only what varies between readings. Partitioned
-- first by the series' retention class (a property's raw-history days, 0 for
-- keep-everything), then by the reading's start, so retention drops whole
-- partitions. The ingest service creates and drops the partitions; a row with
-- no partition is an error, never a default partition. The fixed-width
-- columns come first, widest alignment first, so no row pays alignment
-- padding between them.
CREATE TABLE "conditions"."observation" (
	"series_id" bigint NOT NULL,
	"phenomenon_start" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone DEFAULT '-infinity' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"phenomenon_end" timestamp with time zone,
	"result_time" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"value_num" double precision,
	"fetch_id" bigint,
	"retention_days" smallint NOT NULL,
	"raw_part" smallint,
	"temporality" text NOT NULL,
	"aggregation" text NOT NULL,
	"value_money" numeric(14, 4),
	"value_text" text,
	"value_json" jsonb,
	"quality" jsonb,
	"baseline" jsonb,
	"extra" jsonb,
	CONSTRAINT "observation_pkey" PRIMARY KEY ("series_id", "phenomenon_start", "issued_at", "retention_days"),
	CONSTRAINT "observation_retention_days_check" CHECK ("retention_days" >= 0)
) PARTITION BY LIST ("retention_days");
--> statement-breakpoint
-- History is read by series through the primary key (it leads with
-- series_id) and dropped a partition at a time; only the hourly rollup reads
-- by time alone, an hour of a day partition. Readings arrive roughly in time
-- order, so a block range index serves that read for a few pages a
-- partition, where a btree on time took about a fifth of every row's bytes.
CREATE INDEX "observation_phenomenon_start_idx" ON "conditions"."observation" USING brin ("phenomenon_start");
--> statement-breakpoint
-- A latest row keeps its reading inline and its series template out of
-- line: a row grows past the tuple target only by its template (about a
-- kilobyte), whose storage EXTERNAL moves it to the TOAST table, and an
-- update that keeps it carries only its pointer; the reading's storage MAIN
-- keeps it in the row, so an update writes no TOAST entry. Rows of about a
-- kilobyte leave room on their page for heap-only updates. A flow source
-- rewrites tens of thousands of readings a minute; the template changes when
-- the site does.
ALTER TABLE "conditions"."observation_latest" ALTER COLUMN "template" SET STORAGE EXTERNAL;
--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" ALTER COLUMN "reading" SET STORAGE MAIN;
--> statement-breakpoint
ALTER TABLE "conditions"."observation_latest" SET (toast_tuple_target = 1200, fillfactor = 50);
--> statement-breakpoint
-- A latest row is updated in place by every poll of its source, and nearly
-- every update is heap-only: the next update or read of its page prunes
-- the old version, with no vacuum needed. The default thresholds count those
-- updates as if vacuum had to clean them up, so a flow source rewriting a
-- hundred thousand readings a minute had the table vacuumed every few
-- minutes and analysed every minute, each pass dirtying pages the updates
-- had just written. Vacuum is left for the index entries of the updates
-- that are not heap-only (category readings, expiries), when the dead rows
-- reach half the table, and analysis for when the table has changed twice
-- over: an update changes a reading, not the distribution of series the
-- planner reads.
ALTER TABLE "conditions"."observation_latest" SET (autovacuum_vacuum_scale_factor = 0.5, autovacuum_analyze_scale_factor = 2);
--> statement-breakpoint
-- A fused reading keeps the record IDs of its contributors once, in the
-- reading; its provenance is rebuilt from them when the record is read.
CREATE FUNCTION "conditions".observation_fusion_provenance(
  provenance jsonb, ids jsonb, local_id text
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  merged jsonb;
  refs jsonb;
BEGIN
  IF provenance ->> 'origin' IS DISTINCT FROM 'derived'
     OR COALESCE(provenance ->> 'sourceId', '') NOT IN ('@fused', '@fused-public')
     OR jsonb_typeof(provenance -> 'derivedFrom') IS DISTINCT FROM 'object'
     OR provenance #>> '{derivedFrom,method}' IS DISTINCT FROM 'fusion'
     OR jsonb_typeof(provenance -> 'mergedSources') IS DISTINCT FROM 'array'
     OR jsonb_typeof(ids) IS DISTINCT FROM 'array'
     OR local_id IS NULL OR local_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid compact fused lineage' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(ids) = 0
     OR jsonb_array_length(ids) <> jsonb_array_length(provenance -> 'mergedSources')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(ids) WHERE jsonb_typeof(value) <> 'string')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(provenance -> 'mergedSources')
                WHERE jsonb_typeof(value) <> 'object') THEN
    RAISE EXCEPTION 'Invalid compact fused lineage' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_agg(value || jsonb_build_object('recordId', ids -> (ordinality - 1)::integer)
                   ORDER BY ordinality)
    INTO merged FROM jsonb_array_elements(provenance -> 'mergedSources') WITH ORDINALITY;
  SELECT jsonb_agg(jsonb_build_object('class', 'observation', 'id', value) ORDER BY ordinality)
    INTO refs FROM jsonb_array_elements(ids) WITH ORDINALITY;
  RETURN provenance || jsonb_build_object(
    'recordId', local_id, 'mergedSources', merged,
    'derivedFrom', (provenance -> 'derivedFrom') || jsonb_build_object('records', refs));
END
$$;
--> statement-breakpoint
-- The stored observation a latest row holds: its series template with the
-- reading's own fields, provenance merged (`recordOf` in code). It decodes
-- both the original reading format and the compact local-id format.
CREATE FUNCTION "conditions".observation_record(template jsonb, reading jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT (template - 'namespace' - 'provenance') || (reading - 'provenance' - '_ocFusionRecordIds')
      || jsonb_build_object('provenance',
           CASE WHEN reading ? '_ocFusionRecordIds' THEN
             conditions.observation_fusion_provenance(
               (template -> 'provenance') || COALESCE(reading -> 'provenance', '{}'::jsonb),
               reading -> '_ocFusionRecordIds', reading ->> 'id')
           ELSE (template -> 'provenance') || COALESCE(reading -> 'provenance', '{}'::jsonb) END)
      || CASE WHEN reading ->> 'id' ~ '^[0-9a-f]{64}$' THEN
           jsonb_build_object(
             'id', 'oc:observation:' || (template ->> 'namespace') || ':' || (reading ->> 'id'),
             'canonicalId', encode(sha256(convert_to(
               '[' || to_json(template ->> 'namespace')::text || ','
                   || to_json(reading ->> 'id')::text || ']', 'UTF8')), 'hex'))
         ELSE '{}'::jsonb END
$$;
--> statement-breakpoint
-- Journals this instance's own records into the federation outbox, in the
-- writing transaction. Only records a peer may hold are journalled: a record
-- that reached this instance from a peer carries an origin chain and is that
-- peer's to federate, an on-demand answer, a fused row or a crowd
-- observation never leaves the instance, and neither do a restricted
-- source's records. Journalling is gated on a subscription that wants the
-- class (no `classes` in its filter, or `classes` naming it); observations
-- only for a subscription naming the property, since flow series change by
-- the tens of thousands every minute. A tombstone journals a `delete` with
-- its reason and the revision the record ended at, also when no
-- subscription wants the class any more but the record has entries a peer
-- may have pulled; an erasure (`rights_revoked`) also removes the record's
-- earlier entries, so nothing of it can be served again.
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
-- A journalled delete carries the revision the record ended at, so a
-- subscriber orders it against the record's changes: it ends a copy no newer
-- than that, and a change it received earlier by another channel stays.
CREATE FUNCTION "conditions".federation_journal_tombstone(cls text, rec record) RETURNS void AS $$
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
CREATE FUNCTION "conditions".federation_situation_capture() RETURNS trigger AS $$
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
CREATE FUNCTION "conditions".federation_record_capture() RETURNS trigger AS $$
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
-- Fused rows, full and public, and crowd observations stay on the instance
-- that computed or landed them: a crowd observation's subject is this
-- instance's canonical feature, a cluster of the feature links no peer
-- holds, so the reading would name nothing there.
CREATE FUNCTION "conditions".federation_observation_capture() RETURNS trigger AS $$
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
--> statement-breakpoint
-- Flow credits and permissions. Credits are captured when a measurement is
-- written, never at feature rendering; captured provenance is authoritative
-- and never joins the mutable source catalogue. Native identity remains in
-- rights/contributing; display identity follows the parent.
CREATE FUNCTION conditions.flow_credit_union(credits jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_agg(value ORDER BY value::text), '[]'::jsonb)
  FROM (SELECT DISTINCT flat.value FROM jsonb_array_elements(COALESCE(credits, '[]'::jsonb)) entry
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(entry.value) = 'array'
      THEN entry.value ELSE jsonb_build_array(entry.value) END) flat
    WHERE jsonb_typeof(flat.value) = 'object') c;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_field_sources(fields jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_object_agg(key, ids) FROM (
    SELECT f.key, COALESCE(jsonb_agg(DISTINCT c.value->>'sourceId' ORDER BY c.value->>'sourceId')
      FILTER (WHERE c.value->>'sourceId' IS NOT NULL), '[]'::jsonb) AS ids
    FROM jsonb_each(fields) f LEFT JOIN LATERAL jsonb_array_elements(f.value) c ON true
    GROUP BY f.key
  ) values_by_field;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_native_field_sources(fields jsonb, native_source text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_object_agg(key, ids) FROM (
    SELECT f.key, COALESCE(jsonb_agg(DISTINCT CASE WHEN c.value->>'sourceId' = 'openstreetmap'
        THEN 'openstreetmap' ELSE native_source END ORDER BY CASE WHEN c.value->>'sourceId' = 'openstreetmap'
        THEN 'openstreetmap' ELSE native_source END) FILTER (WHERE c.value IS NOT NULL), '[]'::jsonb) AS ids
    FROM jsonb_each(fields) f LEFT JOIN LATERAL jsonb_array_elements(f.value) c ON true GROUP BY f.key
  ) values_by_field;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_known_fields(fields jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(fields)
  WHERE jsonb_typeof(value) = 'array' AND jsonb_array_length(value) > 0;
$$;
--> statement-breakpoint
-- Captured scoped licence definitions travel with the selected measurement
-- receipts. Permission selection still uses reviewed source IDs and rights.
CREATE FUNCTION conditions.flow_osm_credit()
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '[{"sourceId":"openstreetmap","name":"OpenStreetMap","url":"https://www.openstreetmap.org/copyright","licensing":{"version":1,"bindings":[{"scope":"data","subject":"OpenStreetMap","license":{"kind":"spdx","expression":"ODbL-1.0"}}]},"attributionText":"© OpenStreetMap contributors"}]'::jsonb;
$$;
--> statement-breakpoint
-- Current affirmative policy is synchronized from the reviewed JS registry at boot.
-- Missing measurement evidence and unrecognized IDs fail closed; credits never authorize use.
CREATE FUNCTION conditions.flow_public_licenses(licenses text[])
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT licenses IS NOT NULL AND cardinality(licenses) > 0
    AND NOT EXISTS (SELECT 1 FROM unnest(licenses) l(license)
      WHERE l.license IS NULL OR NOT EXISTS (
        SELECT 1 FROM conditions.public_license_policy p WHERE p.license = l.license));
$$;
--> statement-breakpoint
-- Null/empty member evidence poisons the union instead of silently disappearing.
CREATE FUNCTION conditions.flow_permission_union(inputs jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN inputs IS NOT NULL AND jsonb_array_length(inputs) > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inputs) i
      WHERE jsonb_typeof(i) <> 'array' OR i = '[]'::jsonb)
    THEN ARRAY(SELECT DISTINCT l.license FROM jsonb_array_elements(inputs) i
      CROSS JOIN LATERAL jsonb_array_elements_text(i) l(license) ORDER BY l.license) END;
$$;
--> statement-breakpoint
-- One projection serves native and explicitly captured upstream sources alike.
CREATE FUNCTION conditions.flow_credit_licensing(supplied jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  captured jsonb := supplied->'licensing';
  captured_url text := NULLIF(supplied->>'licenseUrl','');
  declarations jsonb;
  matched integer;
BEGIN
  IF captured_url IS NULL OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(captured->'declarations','[]'::jsonb)) d WHERE d->>'url'=captured_url
    UNION ALL
    SELECT 1 FROM jsonb_array_elements(COALESCE(captured->'bindings','[]'::jsonb)) b WHERE b #>> '{license,url}'=captured_url
  ) THEN RETURN captured; END IF;
  captured := COALESCE(captured,'{"version":1,"bindings":[]}'::jsonb);
  declarations := COALESCE(captured->'declarations','[]'::jsonb);
  SELECT ordinality::integer-1 INTO matched FROM jsonb_array_elements(declarations) WITH ORDINALITY d(value,ordinality)
    WHERE d.value->>'text'=supplied->>'license' AND NOT d.value ? 'url' ORDER BY ordinality LIMIT 1;
  IF matched IS NOT NULL THEN
    declarations := jsonb_set(declarations,ARRAY[matched::text],(declarations->matched)||jsonb_build_object('url',captured_url));
  ELSE
    IF jsonb_array_length(declarations)>=64 OR length(supplied->>'license')>1000 THEN
      RAISE EXCEPTION 'captured licence URL exceeds portable declaration capacity';
    END IF;
    declarations := declarations || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('text',supplied->>'license','url',captured_url)));
  END IF;
  RETURN jsonb_set(captured,'{declarations}',declarations);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_source_credit(native_source text, supplied jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'sourceId', COALESCE(NULLIF(supplied->>'parentSourceId',''),native_source),
    'name', COALESCE(NULLIF(supplied->>'name',''),supplied->>'provider'),
    'url',supplied->>'url','licensing',conditions.flow_credit_licensing(supplied),
    'attributionText',supplied->>'provider','publisher',supplied->'publisher'
  ))),'[]'::jsonb)
  WHERE COALESCE(NULLIF(supplied->>'name',''),supplied->>'provider') IS NOT NULL;
$$;
--> statement-breakpoint
CREATE FUNCTION conditions.flow_credit(native_source text, supplied jsonb, upstream jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH credits AS (
    SELECT 0 AS ord,c.value AS credit FROM jsonb_array_elements(conditions.flow_source_credit(native_source,supplied)) c
    UNION ALL
    SELECT 1,c.value FROM jsonb_array_elements(COALESCE(upstream,'[]'::jsonb)) u
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN u.value ? 'source'
      THEN conditions.flow_source_credit(u.value #>> '{source,sourceId}',u.value #> '{source,attribution}')
      ELSE CASE WHEN NULLIF(u.value->>'publisher','') IS NOT NULL
        THEN jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'sourceId',COALESCE(NULLIF(supplied->>'parentSourceId',''),native_source),
          'name',COALESCE(NULLIF(supplied->>'name',''),supplied->>'provider') || ' – ' || (u.value->>'publisher'),
          'licensing',u.value->'licensing','attributionText',u.value->>'attribution',
          'publisher',jsonb_build_object('name',u.value->>'publisher')
        ))) ELSE '[]'::jsonb END END) c
  ) SELECT COALESCE(jsonb_agg(credit ORDER BY ord,credit::text),'[]'::jsonb)
    FROM (SELECT credit,min(ord) AS ord FROM credits GROUP BY credit) unique_credits;
$$;
--> statement-breakpoint
-- Both declared selectors remain policy facts even for unsealed custom inputs.
CREATE FUNCTION conditions.flow_receipt_permissions(receipt_ids text[], complete boolean, receipt_version integer)
RETURNS text[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN complete IS TRUE THEN conditions.flow_permission_union(jsonb_agg(
    CASE WHEN r.provenance #>> '{attribution,license}' IS NOT NULL THEN to_jsonb(
      ARRAY[r.provenance #>> '{attribution,license}'] || ARRAY(
        SELECT l.license FROM jsonb_array_elements(COALESCE(r.provenance->'upstream','[]'::jsonb)) u
        CROSS JOIN LATERAL(VALUES (CASE WHEN u ? 'license' THEN COALESCE(u->>'license','') END),(CASE WHEN u ? 'source' THEN COALESCE(u #>> '{source,attribution,license}','') END)) l(license)
        WHERE l.license IS NOT NULL)) END)) END
  FROM unnest(receipt_ids) ids(receipt_id)
  LEFT JOIN conditions.contributor_receipt r ON r.id=ids.receipt_id AND r.version=receipt_version;
$$;
--> statement-breakpoint
-- The traffic-flow vector tile OpenMapX serves through Martin; its signature
-- is the contract. Measurements are shown only where every licence the
-- measurement depends on is public and no contributing source is restricted;
-- the OpenStreetMap geometry is always shown.
CREATE FUNCTION conditions.segment_flow(z integer, x integer, y integer, query_params json)
RETURNS bytea AS $$
DECLARE bounds geometry := ST_TileEnvelope(z, x, y); mvt bytea;
BEGIN
  SELECT ST_AsMVT(t, 'segment_flow', 4096, 'geom') INTO mvt FROM (
    SELECT s.segment_id, s.dir, s.highway,
      sp.speed_ratio, sp.los, sp.confidence, sp.current_kph, sp.free_flow_kph,
      1 AS lineage_version,
      COALESCE(sp.field_sources, jsonb_build_object('geometry', jsonb_build_array('openstreetmap')))::text AS field_sources,
      COALESCE(sp.field_contributors, jsonb_build_object('geometry', conditions.flow_osm_credit()))::text AS field_contributors,
      COALESCE(sp.field_lineage_complete, jsonb_build_object('geometry',true,'speed',sp.current_kph IS NULL,'freeFlow',sp.free_flow_kph IS NULL,'ratio',sp.speed_ratio IS NULL,'los',sp.los IS NULL,'confidence',sp.confidence IS NULL))::text AS field_lineage_complete,
      ST_AsMVTGeom(ST_Transform(s.geom, 3857), bounds, 4096, 64, true) AS geom
    FROM conditions.road_segment s
    LEFT JOIN conditions.segment_speed sp ON sp.segment_id = s.segment_id
      AND conditions.flow_public_licenses(sp.permission_licenses)
      AND NOT EXISTS (SELECT 1 FROM conditions.source scope_source
        WHERE scope_source.id = ANY(sp.contributing) AND scope_source.restricted)
    WHERE s.min_zoom <= z AND s.geom && ST_Transform(bounds, 4326)
  ) t WHERE t.geom IS NOT NULL;
  RETURN COALESCE(mvt, ''::bytea);
END;
$$ LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE;
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
--> statement-breakpoint
-- Deleting a crowd reporter also removes its key from what it reported, in
-- the deleting transaction, whoever deletes it: its latest crowd readings,
-- its crowd situations, their revisions and their journal entries lose
-- `provenance.reporter` (the whole object: a reporter without its key is
-- not a valid record, a record without a reporter is). The rows are found
-- through the reporter's evidence, which still names the key until the
-- delete clears it, so no index on the readings is needed and flow updates
-- stay heap-only. Removing the reporter changes neither revision nor
-- evidence, so the capture journals nothing. Its caller holds the crowd lock
-- first, as landings do, so a landing never writes the key back.
CREATE FUNCTION "conditions".reporter_strip_key() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "conditions"."observation_latest" AS l
     SET reading = l.reading #- '{provenance,reporter}'
   WHERE l.crowd_record_id IS NOT NULL
     AND l.crowd_record_id IN (
       SELECT e.record_id FROM "conditions"."report_evidence" AS e
        WHERE e.actor_key_id = OLD.key_id AND e.record_class = 'observation')
     AND l.reading #>> '{provenance,reporter,keyId}' = OLD.key_id;
  UPDATE "conditions"."situation" AS s
     SET record = s.record #- '{provenance,reporter}'
   WHERE s.id IN (
       SELECT e.record_id FROM "conditions"."report_evidence" AS e
        WHERE e.actor_key_id = OLD.key_id AND e.record_class = 'situation')
     AND s.record #>> '{provenance,reporter,keyId}' = OLD.key_id;
  UPDATE "conditions"."situation_revision" AS r
     SET snapshot = r.snapshot #- '{provenance,reporter}'
   WHERE r.situation_id IN (
       SELECT e.record_id FROM "conditions"."report_evidence" AS e
        WHERE e.actor_key_id = OLD.key_id AND e.record_class = 'situation')
     AND r.snapshot #>> '{provenance,reporter,keyId}' = OLD.key_id;
  UPDATE "conditions"."federation_outbox" AS o
     SET snapshot = o.snapshot #- '{provenance,reporter}'
   WHERE o.record_class = 'situation'
     AND o.record_id IN (
       SELECT e.record_id FROM "conditions"."report_evidence" AS e
        WHERE e.actor_key_id = OLD.key_id AND e.record_class = 'situation')
     AND o.snapshot #>> '{provenance,reporter,keyId}' = OLD.key_id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reporter_strip_key BEFORE DELETE ON "conditions"."reporter"
  FOR EACH ROW EXECUTE FUNCTION "conditions".reporter_strip_key();
--> statement-breakpoint
-- The federation journal's first epoch. The timeline is filled in by the
-- federation service once it can read it.
INSERT INTO "conditions"."federation_journal" (epoch, started_at, seen_xid, timeline_id)
VALUES (gen_random_uuid(), now(), pg_snapshot_xmax(pg_current_snapshot()), NULL);
--> statement-breakpoint
-- Grants the roles of OpenMapX's traffic tile and the contributions service
-- exactly what they use, each only if it exists. The ingest service calls it
-- after every migrate, so a role created later gets its grants at the next
-- start. It runs with its caller's rights: only the owner of these objects
-- (or a superuser) can grant on them, and no other role may call it.
CREATE FUNCTION "conditions".grant_consumer_roles() RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- OpenMapX's traffic tile runs as openmapx_tiles_owner, a role OpenMapX
  -- creates that cannot log in. It reads exactly what conditions.segment_flow
  -- reads, so credentials, crowd data and everything else stay unreadable to
  -- it.
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'openmapx_tiles_owner') THEN
    GRANT USAGE ON SCHEMA "conditions" TO openmapx_tiles_owner;
    GRANT SELECT ON "conditions"."road_segment", "conditions"."segment_speed",
      "conditions"."source", "conditions"."public_license_policy" TO openmapx_tiles_owner;
    GRANT EXECUTE ON FUNCTION "conditions".segment_flow(integer, integer, integer, json),
      "conditions".flow_public_licenses(text[]), "conditions".flow_osm_credit()
      TO openmapx_tiles_owner;
  END IF;
  -- The contributions service's own role gets what its queries use. It reads
  -- the migration history to wait for the schema version, and the stored
  -- codes and the secrets key check at start. It keeps the crowd's
  -- reporters, block list, reports, votes and evidence, the issuer's keys and
  -- the tokens it issues and redeems. A report lands as a situation, with its
  -- effects, revision and graph binding, or as a latest reading of a feed's
  -- feature; its evidence refreshes the fused readings, and a cross-check
  -- reads the feeds' readings and their history. Its writes to situations and
  -- latest readings also run the federation capture triggers, which read the
  -- subscriptions and journal into the outbox. Crowd readings keep no history
  -- (every crowd-reported property keeps its latest reading only), and crowd
  -- records carry no relations. The ids of the rows it inserts are identity
  -- columns, whose defaults need no grant on their sequences.
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'openconditions_contributions') THEN
    GRANT USAGE ON SCHEMA "conditions" TO openconditions_contributions;
    GRANT SELECT ON "conditions"."__drizzle_migrations", "conditions"."source",
      "conditions"."feature", "conditions"."feature_component", "conditions"."offer",
      "conditions"."feature_canonical", "conditions"."observation",
      "conditions"."observation_rollup_progress", "conditions"."source_status",
      "conditions"."source_poll_attempt", "conditions"."federation_subscription",
      "conditions"."secrets_key_check" TO openconditions_contributions;
    GRANT INSERT ON "conditions"."situation_revision" TO openconditions_contributions;
    GRANT SELECT, INSERT ON "conditions"."issuer_key", "conditions"."spent_token",
      "conditions"."report_evidence", "conditions"."sub_claim", "conditions"."contributor_receipt",
      "conditions"."federation_outbox" TO openconditions_contributions;
    GRANT SELECT, DELETE ON "conditions"."record_relation" TO openconditions_contributions;
    GRANT SELECT, INSERT, DELETE ON "conditions"."report_refusal", "conditions"."situation_effect"
      TO openconditions_contributions;
    GRANT SELECT, INSERT, UPDATE ON "conditions"."reporter", "conditions"."token_quota",
      "conditions"."situation", "conditions"."binding_queue" TO openconditions_contributions;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "conditions"."block_list",
      "conditions"."observation_latest" TO openconditions_contributions;
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "conditions".grant_consumer_roles() FROM PUBLIC;
