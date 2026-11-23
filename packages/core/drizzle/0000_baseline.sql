CREATE TABLE "conditions"."binding_queue" (
	"record_class" text NOT NULL,
	"record_id" text NOT NULL,
	"effect_id" text DEFAULT '' NOT NULL,
	"record_revision" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "binding_queue_record_class_record_id_effect_id_pk" PRIMARY KEY("record_class","record_id","effect_id")
);
--> statement-breakpoint
CREATE TABLE "conditions"."record_binding" (
	"record_class" text NOT NULL,
	"record_id" text NOT NULL,
	"effect_id" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"confidence" double precision,
	"direction_mode" text NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"alternative_confidence" double precision,
	"reason" text,
	"resolver_version" text NOT NULL,
	"geom_hash" text NOT NULL,
	"record_revision" integer NOT NULL,
	"graph_generation" text,
	"bound_at" timestamp with time zone NOT NULL,
	CONSTRAINT "record_binding_record_class_record_id_effect_id_pk" PRIMARY KEY("record_class","record_id","effect_id"),
	CONSTRAINT "record_binding_record_class_enum" CHECK ("record_class" IN ('feature', 'situation', 'observation', 'offer'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."record_segment" (
	"record_class" text NOT NULL,
	"record_id" text NOT NULL,
	"effect_id" text DEFAULT '' NOT NULL,
	"seq" smallint NOT NULL,
	"segment_id" text NOT NULL,
	"way_id" bigint NOT NULL,
	"dir" text NOT NULL,
	"start_fraction" double precision NOT NULL,
	"end_fraction" double precision NOT NULL,
	CONSTRAINT "record_segment_record_class_record_id_effect_id_seq_pk" PRIMARY KEY("record_class","record_id","effect_id","seq")
);
--> statement-breakpoint
CREATE TABLE "conditions"."report_evidence" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"record_class" text NOT NULL,
	"record_id" text NOT NULL,
	"component_key" text DEFAULT '' NOT NULL,
	"evidence_kind" text NOT NULL,
	"actor_key_id" text,
	"source_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "report_evidence_kind_enum" CHECK ("evidence_kind" IN ('report', 'confirm', 'negate', 'official_match', 'reviewer_accept', 'reviewer_reject')),
	CONSTRAINT "report_evidence_record_class_enum" CHECK ("record_class" IN ('feature', 'situation', 'observation', 'offer'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."report_refusal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_key_id" text NOT NULL,
	"cell" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."sub_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_class" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_component_key" text DEFAULT '' NOT NULL,
	"claim_type" text NOT NULL,
	"key_id" text NOT NULL,
	"reason" text,
	"geom" geometry(Point, 4326),
	"signature" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sub_claim_claim_type_enum" CHECK ("claim_type" IN ('confirm', 'negate', 'flag')),
	CONSTRAINT "sub_claim_subject_class_enum" CHECK ("subject_class" IN ('feature', 'situation', 'observation', 'offer'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."jma_budget" (
	"egress" text NOT NULL,
	"day" text NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "jma_budget_egress_day_pk" PRIMARY KEY("egress","day"),
	CONSTRAINT "jma_budget_nonnegative" CHECK ("conditions"."jma_budget"."used" >= 0 AND "conditions"."jma_budget"."reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conditions"."jma_download" (
	"url" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."jma_state" (
	"source" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."contributor_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"version" smallint NOT NULL,
	"contributors" jsonb NOT NULL,
	"provenance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."observation_latest" (
	"series_id" bigserial PRIMARY KEY NOT NULL,
	"subject_key" text NOT NULL,
	"property" text NOT NULL,
	"qualifier_key" text DEFAULT '' NOT NULL,
	"source_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"feature_id" text,
	"component_key" text,
	"situation_id" text,
	"geom" geometry(Geometry, 4326),
	"reading" jsonb NOT NULL,
	"template" jsonb NOT NULL,
	"template_hash" text NOT NULL,
	"contributor_receipt_id" text,
	"crowd_record_id" text,
	"access_mode" text NOT NULL,
	"result_type" text NOT NULL,
	"value_num" double precision,
	"value_money" numeric(14, 4),
	"value_text" text,
	"unit" text,
	"currency" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"since_at" timestamp with time zone NOT NULL,
	"fused_from" text[],
	"fused_sources" text[],
	"fused_public" boolean,
	"evidence_state" text,
	"confidence_score" double precision,
	"corroborations" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"retention_days" smallint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_latest_series" UNIQUE("subject_key","property","qualifier_key","source_id"),
	CONSTRAINT "observation_latest_access_mode_enum" CHECK ("access_mode" IN ('bulk', 'on_demand')),
	CONSTRAINT "observation_latest_evidence_state_enum" CHECK (evidence_state IS NULL OR "evidence_state" IN ('self_reported', 'corroborated', 'externally_resolved', 'negated', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."observation_rollup_daily" (
	"series_id" bigint NOT NULL,
	"day_utc" date NOT NULL,
	"sample_count" integer NOT NULL,
	"contributor_receipt_ids" text[],
	"lineage_complete" boolean DEFAULT false NOT NULL,
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"mean" double precision NOT NULL,
	CONSTRAINT "observation_rollup_daily_series_id_day_utc_pk" PRIMARY KEY("series_id","day_utc")
);
--> statement-breakpoint
CREATE TABLE "conditions"."observation_rollup_hourly" (
	"series_id" bigint NOT NULL,
	"hour_utc" timestamp with time zone NOT NULL,
	"sample_count" integer NOT NULL,
	"contributor_receipt_ids" text[],
	"lineage_complete" boolean DEFAULT false NOT NULL,
	"bins" smallint[],
	"counts" integer[],
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"mean" double precision NOT NULL,
	CONSTRAINT "observation_rollup_hourly_series_id_hour_utc_pk" PRIMARY KEY("series_id","hour_utc")
);
--> statement-breakpoint
CREATE TABLE "conditions"."observation_rollup_progress" (
	"period" text PRIMARY KEY NOT NULL,
	"finalized_before" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."raw_payload" (
	"source_id" text NOT NULL,
	"hash" text NOT NULL,
	"url_key" text NOT NULL,
	"fetch_id" bigint,
	"media_type" text,
	"bytes_raw" bigint NOT NULL,
	"bytes_stored" bigint NOT NULL,
	"first_fetched_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"tier" text NOT NULL,
	"pinned_reason" text,
	"storage_key" text NOT NULL,
	"base_hash" text,
	"evicted_at" timestamp with time zone,
	CONSTRAINT "raw_payload_pk" PRIMARY KEY("source_id","hash"),
	CONSTRAINT "raw_payload_tier_enum" CHECK ("tier" IN ('situation', 'observation', 'reference', 'hot'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."feature" (
	"id" text PRIMARY KEY NOT NULL,
	"record" jsonb NOT NULL,
	"canonical_id" text NOT NULL,
	"kind" text NOT NULL,
	"type" text,
	"subtype" text,
	"domain" text NOT NULL,
	"temporality" text NOT NULL,
	"source_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"origin" text NOT NULL,
	"access_mode" text NOT NULL,
	"privacy_class" text NOT NULL,
	"instance_id" text NOT NULL,
	"revision" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"geom" geometry(Geometry, 4326),
	"country" text,
	"subdivision" text,
	"tombstone_reason" text,
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifecycle" text NOT NULL,
	CONSTRAINT "feature_temporality_enum" CHECK ("temporality" IN ('static', 'scheduled', 'live', 'forecast')),
	CONSTRAINT "feature_origin_enum" CHECK ("origin" IN ('feed', 'crowd', 'federation', 'derived')),
	CONSTRAINT "feature_access_mode_enum" CHECK ("access_mode" IN ('bulk', 'on_demand')),
	CONSTRAINT "feature_privacy_class_enum" CHECK ("privacy_class" IN ('authoritative', 'aggregate', 'k_anon', 'dp_noised', 'crowd_pseudonym')),
	CONSTRAINT "feature_tombstone_reason_enum" CHECK (tombstone_reason IS NULL OR "tombstone_reason" IN ('expired', 'withdrawn', 'superseded', 'cancelled', 'rights_revoked', 'rejected')),
	CONSTRAINT "feature_tombstone_complete" CHECK ((tombstone_reason IS NULL) = (tombstoned_at IS NULL)),
	CONSTRAINT "feature_revision_positive" CHECK (revision > 0),
	CONSTRAINT "feature_lifecycle_enum" CHECK ("lifecycle" IN ('planned', 'under_construction', 'operational', 'temporarily_closed', 'decommissioned', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."feature_canonical" (
	"canonical_feature_id" text PRIMARY KEY NOT NULL,
	"survivor_id" text NOT NULL,
	"member_ids" text[] NOT NULL,
	"merged_sources" jsonb,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."feature_component" (
	"feature_id" text NOT NULL,
	"key" text NOT NULL,
	"parent_key" text,
	"kind" text NOT NULL,
	"lifecycle" text,
	"position" geometry(Point, 4326),
	"external_ids" jsonb,
	"details" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	CONSTRAINT "feature_component_feature_id_key_pk" PRIMARY KEY("feature_id","key"),
	CONSTRAINT "feature_component_lifecycle_enum" CHECK (lifecycle IS NULL OR "lifecycle" IN ('planned', 'under_construction', 'operational', 'temporarily_closed', 'decommissioned', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."feature_link" (
	"a_id" text NOT NULL,
	"b_id" text NOT NULL,
	"method" text NOT NULL,
	"confidence" double precision NOT NULL,
	"status" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feature_link_a_id_b_id_pk" PRIMARY KEY("a_id","b_id"),
	CONSTRAINT "feature_link_ordered" CHECK ("conditions"."feature_link"."a_id" < "conditions"."feature_link"."b_id" COLLATE "C"),
	CONSTRAINT "feature_link_method_enum" CHECK ("method" IN ('external_id', 'spatial_attribute', 'manual')),
	CONSTRAINT "feature_link_status_enum" CHECK ("status" IN ('accepted', 'rejected', 'pending'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."feature_revision" (
	"feature_id" text NOT NULL,
	"revision" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"change_kinds" text[] NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "feature_revision_feature_id_revision_pk" PRIMARY KEY("feature_id","revision")
);
--> statement-breakpoint
CREATE TABLE "conditions"."offer" (
	"id" text PRIMARY KEY NOT NULL,
	"record" jsonb NOT NULL,
	"canonical_id" text NOT NULL,
	"kind" text NOT NULL,
	"type" text,
	"subtype" text,
	"domain" text NOT NULL,
	"temporality" text NOT NULL,
	"source_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"origin" text NOT NULL,
	"access_mode" text NOT NULL,
	"privacy_class" text NOT NULL,
	"instance_id" text NOT NULL,
	"revision" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"geom" geometry(Geometry, 4326),
	"country" text,
	"subdivision" text,
	"tombstone_reason" text,
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject_class" text NOT NULL,
	"subject_id" text NOT NULL,
	"component_key" text,
	"currency" text NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"min_price" numeric(14, 4),
	"max_price" numeric(14, 4),
	CONSTRAINT "offer_temporality_enum" CHECK ("temporality" IN ('static', 'scheduled', 'live', 'forecast')),
	CONSTRAINT "offer_origin_enum" CHECK ("origin" IN ('feed', 'crowd', 'federation', 'derived')),
	CONSTRAINT "offer_access_mode_enum" CHECK ("access_mode" IN ('bulk', 'on_demand')),
	CONSTRAINT "offer_privacy_class_enum" CHECK ("privacy_class" IN ('authoritative', 'aggregate', 'k_anon', 'dp_noised', 'crowd_pseudonym')),
	CONSTRAINT "offer_tombstone_reason_enum" CHECK (tombstone_reason IS NULL OR "tombstone_reason" IN ('expired', 'withdrawn', 'superseded', 'cancelled', 'rights_revoked', 'rejected')),
	CONSTRAINT "offer_tombstone_complete" CHECK ((tombstone_reason IS NULL) = (tombstoned_at IS NULL)),
	CONSTRAINT "offer_revision_positive" CHECK (revision > 0),
	CONSTRAINT "offer_subject_class_enum" CHECK ("subject_class" IN ('feature', 'situation', 'observation', 'offer'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."offer_revision" (
	"offer_id" text NOT NULL,
	"revision" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"change_kinds" text[] NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "offer_revision_offer_id_revision_pk" PRIMARY KEY("offer_id","revision")
);
--> statement-breakpoint
CREATE TABLE "conditions"."record_relation" (
	"from_class" text NOT NULL,
	"from_id" text NOT NULL,
	"relation" text NOT NULL,
	"to_class" text NOT NULL,
	"to_id" text NOT NULL,
	"component_key" text DEFAULT '' NOT NULL,
	CONSTRAINT "record_relation_pk" PRIMARY KEY("from_class","from_id","relation","to_class","to_id","component_key"),
	CONSTRAINT "record_relation_from_class_enum" CHECK ("from_class" IN ('feature', 'situation', 'observation', 'offer')),
	CONSTRAINT "record_relation_to_class_enum" CHECK ("to_class" IN ('feature', 'situation', 'observation', 'offer')),
	CONSTRAINT "record_relation_relation_enum" CHECK ("relation" IN ('part_of', 'monitors', 'controls', 'serves', 'group', 'next_occurrence', 'first_occurrence', 'related_work_zone', 'caused_by', 'detour_for', 'supersedes', 'update_of', 'cancels', 'related'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."situation" (
	"id" text PRIMARY KEY NOT NULL,
	"record" jsonb NOT NULL,
	"canonical_id" text NOT NULL,
	"kind" text NOT NULL,
	"type" text,
	"subtype" text,
	"domain" text NOT NULL,
	"temporality" text NOT NULL,
	"source_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"origin" text NOT NULL,
	"access_mode" text NOT NULL,
	"privacy_class" text NOT NULL,
	"instance_id" text NOT NULL,
	"revision" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"geom" geometry(Geometry, 4326),
	"country" text,
	"subdivision" text,
	"tombstone_reason" text,
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"severity" text NOT NULL,
	"severity_level" smallint,
	"certainty" text NOT NULL,
	"planned" boolean NOT NULL,
	"validity_status" text NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"group_id" text,
	"evidence_state" text,
	"confidence_score" double precision,
	"routing_eligible" boolean DEFAULT false NOT NULL,
	"corroborations" integer DEFAULT 0 NOT NULL,
	"flagged_at" timestamp with time zone,
	CONSTRAINT "situation_temporality_enum" CHECK ("temporality" IN ('static', 'scheduled', 'live', 'forecast')),
	CONSTRAINT "situation_origin_enum" CHECK ("origin" IN ('feed', 'crowd', 'federation', 'derived')),
	CONSTRAINT "situation_access_mode_enum" CHECK ("access_mode" IN ('bulk', 'on_demand')),
	CONSTRAINT "situation_privacy_class_enum" CHECK ("privacy_class" IN ('authoritative', 'aggregate', 'k_anon', 'dp_noised', 'crowd_pseudonym')),
	CONSTRAINT "situation_tombstone_reason_enum" CHECK (tombstone_reason IS NULL OR "tombstone_reason" IN ('expired', 'withdrawn', 'superseded', 'cancelled', 'rights_revoked', 'rejected')),
	CONSTRAINT "situation_tombstone_complete" CHECK ((tombstone_reason IS NULL) = (tombstoned_at IS NULL)),
	CONSTRAINT "situation_revision_positive" CHECK (revision > 0),
	CONSTRAINT "situation_severity_enum" CHECK ("severity" IN ('none', 'minor', 'moderate', 'major', 'critical', 'unknown')),
	CONSTRAINT "situation_severity_level_range" CHECK ("conditions"."situation"."severity_level" IS NULL OR "conditions"."situation"."severity_level" BETWEEN 1 AND 5),
	CONSTRAINT "situation_certainty_enum" CHECK ("certainty" IN ('observed', 'likely', 'possible', 'unlikely', 'unknown')),
	CONSTRAINT "situation_validity_status_enum" CHECK ("validity_status" IN ('planned', 'active', 'suspended', 'ended', 'cancelled', 'unknown')),
	CONSTRAINT "situation_evidence_state_enum" CHECK (evidence_state IS NULL OR "evidence_state" IN ('self_reported', 'corroborated', 'externally_resolved', 'negated', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."situation_effect" (
	"situation_id" text NOT NULL,
	"effect_id" text NOT NULL,
	"phase_id" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"applicability_kind" text NOT NULL,
	"normalization" text NOT NULL,
	"compliance" text NOT NULL,
	"direction" text,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"geom" geometry(Geometry, 4326),
	"value" jsonb NOT NULL,
	CONSTRAINT "situation_effect_situation_id_effect_id_pk" PRIMARY KEY("situation_id","effect_id"),
	CONSTRAINT "situation_effect_applicability_enum" CHECK ("applicability_kind" IN ('all', 'classes', 'unknown')),
	CONSTRAINT "situation_effect_normalization_enum" CHECK ("normalization" IN ('complete', 'partial', 'unsupported')),
	CONSTRAINT "situation_effect_compliance_enum" CHECK ("compliance" IN ('mandatory', 'advisory', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."situation_revision" (
	"situation_id" text NOT NULL,
	"revision" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"change_kinds" text[] NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "situation_revision_situation_id_revision_pk" PRIMARY KEY("situation_id","revision")
);
--> statement-breakpoint
CREATE TABLE "conditions"."archive_erasure" (
	"key" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."archive_file" (
	"record_class" text PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"built_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."block_list" (
	"key_id" text PRIMARY KEY NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_blocklist" (
	"peer_id" text PRIMARY KEY NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_instance_key" (
	"key_id" text PRIMARY KEY NOT NULL,
	"public_key" "bytea" NOT NULL,
	"private_key" "bytea" NOT NULL,
	"multibase" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"endorsed_by" text,
	"endorsement" "bytea",
	"endorsement_proof" "bytea"
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_journal" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"epoch" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"seen_xid" "xid8" NOT NULL,
	"timeline_id" integer,
	"database_oid" bigint,
	"system_identifier" bigint,
	CONSTRAINT "federation_journal_single_row" CHECK ("conditions"."federation_journal"."singleton")
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_lapsed_copy" (
	"record_class" text NOT NULL,
	"record_id" text NOT NULL,
	"peer_instance_id" text NOT NULL,
	"source_id" text NOT NULL,
	"revision" integer NOT NULL,
	"lapsed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "federation_lapsed_copy_record_class_record_id_pk" PRIMARY KEY("record_class","record_id")
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_outbox" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"record_class" text NOT NULL,
	"record_id" text NOT NULL,
	"canonical_id" text,
	"kind" text NOT NULL,
	"domain" text NOT NULL,
	"property" text,
	"priority" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb,
	"tombstone_reason" text,
	"revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"txid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "federation_outbox_operation_enum" CHECK ("conditions"."federation_outbox"."operation" IN ('create','update','delete','liveness')),
	CONSTRAINT "federation_outbox_record_class_enum" CHECK ("record_class" IN ('feature', 'situation', 'observation', 'offer')),
	CONSTRAINT "federation_outbox_delete_shape" CHECK (("conditions"."federation_outbox"."operation" = 'delete') = ("conditions"."federation_outbox"."snapshot" IS NULL AND "conditions"."federation_outbox"."tombstone_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_peer_capabilities" (
	"peer_instance_id" text PRIMARY KEY NOT NULL,
	"schema_versions" text[] NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"protocol_version" text
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_peer_cursor" (
	"peer_instance_id" text PRIMARY KEY NOT NULL,
	"cursor" text DEFAULT '0.0' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archive_built_at" timestamp with time zone,
	"archive_landed_at" timestamp with time zone,
	"journal_epoch" text,
	"cursor_reset_at" timestamp with time zone,
	"reconcile_due_since" timestamp with time zone,
	"reconcile_class" text,
	"reconcile_after" text,
	"reconciled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_peer_health" (
	"peer_id" text PRIMARY KEY NOT NULL,
	"availability_ok" integer DEFAULT 0 NOT NULL,
	"availability_fail" integer DEFAULT 0 NOT NULL,
	"signature_failures" integer DEFAULT 0 NOT NULL,
	"replay_failures" integer DEFAULT 0 NOT NULL,
	"schema_failures" integer DEFAULT 0 NOT NULL,
	"rate_violations" integer DEFAULT 0 NOT NULL,
	"effective_tier_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_peer_key" (
	"peer_instance_id" text NOT NULL,
	"key_id" text NOT NULL,
	"anchor" text NOT NULL,
	"learned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "federation_peer_key_peer_instance_id_key_id_pk" PRIMARY KEY("peer_instance_id","key_id")
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_source_receipt" (
	"peer_instance_id" text NOT NULL,
	"source_id" text NOT NULL,
	"last_received_at" timestamp with time zone NOT NULL,
	"liveness_at" timestamp with time zone,
	"cadence_sec" integer,
	CONSTRAINT "federation_source_receipt_peer_instance_id_source_id_pk" PRIMARY KEY("peer_instance_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"peer_id" text NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivery_mode" text DEFAULT 'pull' NOT NULL,
	"inbox_url" text,
	"cursor" text DEFAULT '0.0' NOT NULL,
	"priority_only" boolean DEFAULT true NOT NULL,
	"push_failures" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	CONSTRAINT "federation_subscription_delivery_mode_enum" CHECK ("conditions"."federation_subscription"."delivery_mode" IN ('pull','webhook','sse'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."federation_tombstone" (
	"canonical_id" text NOT NULL,
	"peer_instance_id" text DEFAULT '' NOT NULL,
	"reason" text NOT NULL,
	"tombstoned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "federation_tombstone_canonical_id_peer_instance_id_pk" PRIMARY KEY("canonical_id","peer_instance_id")
);
--> statement-breakpoint
CREATE TABLE "conditions"."geonet_coverage" (
	"revisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_id" text PRIMARY KEY NOT NULL,
	"covered_from" timestamp with time zone NOT NULL,
	"covered_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."issuer_key" (
	"key_id" text PRIMARY KEY NOT NULL,
	"public_key" "bytea" NOT NULL,
	"private_key" "bytea" NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."nsw_rfs_clock" (
	"source_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"sent" text NOT NULL,
	"published" text NOT NULL,
	"content" text NOT NULL,
	"expiry" text NOT NULL,
	CONSTRAINT "nsw_rfs_clock_source_id_incident_id_pk" PRIMARY KEY("source_id","incident_id")
);
--> statement-breakpoint
CREATE TABLE "conditions"."observation_revision" (
	"source_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"property" text NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"rank" text NOT NULL,
	"signature" text NOT NULL,
	"suppressed" boolean NOT NULL,
	CONSTRAINT "observation_revision_source_id_feature_id_property_pk" PRIMARY KEY("source_id","feature_id","property")
);
--> statement-breakpoint
CREATE TABLE "conditions"."on_demand_fetch" (
	"source_id" text NOT NULL,
	"cell" text NOT NULL,
	"fetched_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" text NOT NULL,
	"retry_at" timestamp with time zone,
	"claimed_until" timestamp with time zone,
	CONSTRAINT "on_demand_fetch_source_id_cell_pk" PRIMARY KEY("source_id","cell"),
	CONSTRAINT "on_demand_fetch_status_enum" CHECK ("conditions"."on_demand_fetch"."status" IN ('pending','fresh','failed'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."on_demand_quota" (
	"source_id" text PRIMARY KEY NOT NULL,
	"tokens" real NOT NULL,
	"refilled_at" timestamp with time zone NOT NULL,
	"day" date NOT NULL,
	"day_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."osm_road" (
	"way_id" bigint PRIMARY KEY NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	"highway" text NOT NULL,
	"oneway" boolean DEFAULT false NOT NULL,
	"oneway_reversed" boolean DEFAULT false NOT NULL,
	"ref" text,
	"name" text,
	"maxspeed_kph" double precision,
	"region" text NOT NULL,
	"import_config_hash" text,
	"import_provenance" jsonb,
	"imported_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."public_license_policy" (
	"license" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."reporter" (
	"key_id" text PRIMARY KEY NOT NULL,
	"pub_jwk" jsonb NOT NULL,
	"osm_uid" text,
	"email_lookup_hmac" text,
	"reputation_alpha" double precision NOT NULL,
	"reputation_beta" double precision NOT NULL,
	"corroborated_count" integer DEFAULT 0 NOT NULL,
	"flagged_count" integer DEFAULT 0 NOT NULL,
	"trust_signal" double precision,
	"entitlement_expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reporter_reputation_alpha_positive" CHECK ("conditions"."reporter"."reputation_alpha" > 0),
	CONSTRAINT "reporter_reputation_beta_positive" CHECK ("conditions"."reporter"."reputation_beta" > 0),
	CONSTRAINT "reporter_status_enum" CHECK ("conditions"."reporter"."status" IN ('active','blocked'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."road_graph_state" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"generation" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"regions" jsonb NOT NULL,
	"highway_classes" jsonb NOT NULL,
	"pbf_provenance" jsonb NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "road_graph_state_singleton" CHECK ("conditions"."road_graph_state"."singleton" IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "conditions"."road_segment" (
	"segment_id" text PRIMARY KEY NOT NULL,
	"way_id" bigint NOT NULL,
	"dir" text NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	"highway" text NOT NULL,
	"ref" text,
	"length_m" double precision NOT NULL,
	"min_zoom" smallint NOT NULL,
	"free_flow_kph" double precision,
	"openlr" text,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."segment_observation" (
	"segment_id" text NOT NULL,
	"source" text NOT NULL,
	"source_tier" text NOT NULL,
	"current_kph" double precision,
	"free_flow_kph" double precision,
	"speed_ratio" double precision,
	"los" text NOT NULL,
	"confidence" double precision NOT NULL,
	"sample_count" integer,
	"native_field_sources" jsonb,
	"field_sources" jsonb,
	"field_contributors" jsonb,
	"field_lineage_complete" jsonb,
	"permission_licenses" text[],
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "segment_observation_segment_id_source_pk" PRIMARY KEY("segment_id","source")
);
--> statement-breakpoint
CREATE TABLE "conditions"."segment_profile" (
	"segment_id" text NOT NULL,
	"dow" smallint NOT NULL,
	"tod_hour" smallint NOT NULL,
	"speed_kph" double precision NOT NULL,
	"sample_count" integer NOT NULL,
	"contributor_receipt_ids" text[],
	"lineage_complete" boolean DEFAULT false NOT NULL,
	"permission_licenses" text[],
	"contributing" text[] DEFAULT '{}'::text[] NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "segment_profile_segment_id_dow_tod_hour_pk" PRIMARY KEY("segment_id","dow","tod_hour")
);
--> statement-breakpoint
CREATE TABLE "conditions"."segment_speed" (
	"segment_id" text PRIMARY KEY NOT NULL,
	"current_kph" double precision,
	"free_flow_kph" double precision,
	"speed_ratio" double precision,
	"los" text NOT NULL,
	"confidence" text NOT NULL,
	"source_tier" text,
	"contributing" text[],
	"is_estimated" boolean DEFAULT false NOT NULL,
	"native_field_sources" jsonb,
	"field_sources" jsonb,
	"field_contributors" jsonb,
	"field_lineage_complete" jsonb,
	"permission_licenses" text[],
	"observed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."sensor_baseline" (
	"subject_key" text NOT NULL,
	"source" text NOT NULL,
	"dow_bucket" smallint NOT NULL,
	"tod_bucket" smallint NOT NULL,
	"free_flow_kph" double precision NOT NULL,
	"method" text NOT NULL,
	"contributor_receipt_ids" text[],
	"lineage_complete" boolean DEFAULT false NOT NULL,
	"permission_licenses" text[],
	"contributing" text[],
	"sample_count" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sensor_baseline_subject_key_dow_bucket_tod_bucket_method_pk" PRIMARY KEY("subject_key","dow_bucket","tod_bucket","method")
);
--> statement-breakpoint
CREATE TABLE "conditions"."sensor_segment" (
	"subject_key" text PRIMARY KEY NOT NULL,
	"segment_id" text NOT NULL,
	"fraction" double precision NOT NULL,
	"offset_m" double precision NOT NULL,
	"bearing_deg" double precision,
	"matched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."smn_cap_decision" (
	"source_id" text PRIMARY KEY NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"decision" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."smn_cap_message" (
	"source_id" text NOT NULL,
	"identifier" text NOT NULL,
	"variant" text GENERATED ALWAYS AS (encode(sha256(body), 'hex')) STORED NOT NULL,
	"retrieval" jsonb DEFAULT '{"legacy":true}'::jsonb NOT NULL,
	"body" "bytea" NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "smn_cap_message_source_id_variant_pk" PRIMARY KEY("source_id","variant")
);
--> statement-breakpoint
CREATE TABLE "conditions"."source_poll_attempt" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"network_validated" boolean NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"active_event_count" integer,
	"inserted" integer,
	"updated" integer,
	"deleted" integer,
	"rejected" integer,
	"duration_ms" integer,
	"partitions_succeeded" integer,
	"partitions_failed" integer,
	"partitions_total" integer,
	"error" text,
	"payload_hashes" text[]
);
--> statement-breakpoint
CREATE TABLE "conditions"."source_shrink" (
	"source_id" text NOT NULL,
	"scope" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"polls" integer NOT NULL,
	"stated" integer NOT NULL,
	"held" integer NOT NULL,
	CONSTRAINT "source_shrink_source_id_scope_pk" PRIMARY KEY("source_id","scope"),
	CONSTRAINT "source_shrink_scope_enum" CHECK ("conditions"."source_shrink"."scope" IN ('series','records'))
);
--> statement-breakpoint
CREATE TABLE "conditions"."source_status" (
	"source" text PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_network_success_at" timestamp with time zone,
	"freshness_deadline" timestamp with time zone,
	"source_published_at" timestamp with time zone,
	"last_publication_at" timestamp with time zone,
	"publication_revision" bigint DEFAULT 0 NOT NULL,
	"last_outcome" text,
	"freshness_window_sec" integer NOT NULL,
	"last_row_count" integer,
	"active_event_count" integer,
	"last_inserted" integer,
	"last_updated" integer,
	"last_deleted" integer,
	"last_rejected" integer,
	"last_duration_ms" integer,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"raw_hot_evicted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."spent_token" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"spent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conditions"."token_quota" (
	"key_id" text NOT NULL,
	"epoch" text NOT NULL,
	"issued" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "token_quota_key_id_epoch_pk" PRIMARY KEY("key_id","epoch")
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "conditions"."source" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"format" text NOT NULL,
	"product" text NOT NULL,
	"access_mode" text NOT NULL,
	"tier" text NOT NULL,
	"country" text,
	"subdivision" text,
	"operator" text NOT NULL,
	"license" text NOT NULL,
	"license_url" text,
	"attribution" text NOT NULL,
	"credit_name" text,
	"credit_url" text,
	"credit_notice" text,
	"rights" jsonb,
	"restricted" boolean DEFAULT false NOT NULL,
	"restricted_since" timestamp with time zone,
	"fusion_restricted" boolean,
	"fusion_tier" text,
	"fusion_licenses" text,
	"federation_restricted" boolean,
	"federation_pending" boolean DEFAULT false NOT NULL,
	"cadence_sec" integer NOT NULL,
	"freshness_window_sec" integer NOT NULL,
	"raw_retention" text,
	"extras_allow" text[] DEFAULT '{}'::text[] NOT NULL,
	"extras_federate" boolean DEFAULT false NOT NULL,
	"lane_numbering" text,
	"parent_source_id" text,
	"policy_ids" text[],
	"selection_state" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_access_mode_enum" CHECK ("access_mode" IN ('bulk', 'on_demand')),
	CONSTRAINT "source_tier_enum" CHECK ("tier" IN ('authoritative', 'operator', 'aggregator', 'community'))
);
--> statement-breakpoint
ALTER TABLE "conditions"."observation_rollup_daily" ADD CONSTRAINT "observation_rollup_daily_series_fk" FOREIGN KEY ("series_id") REFERENCES "conditions"."observation_latest"("series_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."observation_rollup_hourly" ADD CONSTRAINT "observation_rollup_hourly_series_fk" FOREIGN KEY ("series_id") REFERENCES "conditions"."observation_latest"("series_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."feature_component" ADD CONSTRAINT "feature_component_feature_id_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "conditions"."feature"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."feature_revision" ADD CONSTRAINT "feature_revision_feature_id_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "conditions"."feature"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."offer_revision" ADD CONSTRAINT "offer_revision_offer_id_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "conditions"."offer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."situation_effect" ADD CONSTRAINT "situation_effect_situation_id_situation_id_fk" FOREIGN KEY ("situation_id") REFERENCES "conditions"."situation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."situation_revision" ADD CONSTRAINT "situation_revision_situation_id_situation_id_fk" FOREIGN KEY ("situation_id") REFERENCES "conditions"."situation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_binding_queue_due" ON "conditions"."binding_queue" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_record_binding_status" ON "conditions"."record_binding" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_record_segment_segment" ON "conditions"."record_segment" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "idx_report_evidence_record" ON "conditions"."report_evidence" USING btree ("record_class","record_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_report_evidence_actor" ON "conditions"."report_evidence" USING btree ("actor_key_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_report_evidence_merged" ON "conditions"."report_evidence" USING btree (("details" ->> 'merged')) WHERE "conditions"."report_evidence"."details" ? 'merged';--> statement-breakpoint
CREATE INDEX "idx_report_refusal_actor" ON "conditions"."report_refusal" USING btree ("actor_key_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_report_refusal_occurred" ON "conditions"."report_refusal" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sub_claim_subject_key_type" ON "conditions"."sub_claim" USING btree ("subject_class","subject_id","subject_component_key","key_id","claim_type");--> statement-breakpoint
CREATE INDEX "idx_sub_claim_key" ON "conditions"."sub_claim" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "idx_observation_latest_geom" ON "conditions"."observation_latest" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_observation_latest_property_text" ON "conditions"."observation_latest" USING btree ("property","value_text");--> statement-breakpoint
CREATE INDEX "idx_observation_latest_source" ON "conditions"."observation_latest" USING btree ("source_id","series_id");--> statement-breakpoint
CREATE INDEX "idx_observation_latest_component" ON "conditions"."observation_latest" USING btree ("feature_id","component_key");--> statement-breakpoint
CREATE INDEX "idx_observation_latest_fuel_price" ON "conditions"."observation_latest" USING btree ("value_money") WHERE "conditions"."observation_latest"."property" = 'fuel.price';--> statement-breakpoint
CREATE INDEX "idx_observation_latest_expires" ON "conditions"."observation_latest" USING btree ("expires_at") WHERE "conditions"."observation_latest"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_observation_latest_effective_brin" ON "conditions"."observation_latest" USING brin ("effective_from");--> statement-breakpoint
CREATE INDEX "idx_observation_latest_crowd_record" ON "conditions"."observation_latest" USING btree ("crowd_record_id") WHERE "conditions"."observation_latest"."crowd_record_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_observation_rollup_daily_day" ON "conditions"."observation_rollup_daily" USING btree ("day_utc");--> statement-breakpoint
CREATE INDEX "idx_observation_rollup_hourly_hour" ON "conditions"."observation_rollup_hourly" USING btree ("hour_utc");--> statement-breakpoint
CREATE INDEX "idx_raw_payload_source_time" ON "conditions"."raw_payload" USING btree ("source_id","first_fetched_at");--> statement-breakpoint
CREATE INDEX "idx_raw_payload_tier_seen" ON "conditions"."raw_payload" USING btree ("tier","last_seen_at") WHERE "conditions"."raw_payload"."evicted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_raw_payload_base" ON "conditions"."raw_payload" USING btree ("source_id","base_hash") WHERE "conditions"."raw_payload"."base_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_feature_geom" ON "conditions"."feature" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_feature_kind_type" ON "conditions"."feature" USING btree ("kind","type");--> statement-breakpoint
CREATE INDEX "idx_feature_source" ON "conditions"."feature" USING btree ("source_id","id");--> statement-breakpoint
CREATE INDEX "idx_feature_canonical" ON "conditions"."feature" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "idx_feature_kind_lifecycle" ON "conditions"."feature" USING btree ("kind","lifecycle");--> statement-breakpoint
CREATE INDEX "idx_feature_external_ids" ON "conditions"."feature" USING gin (("record" -> 'externalIds') jsonb_path_ops) WITH (fastupdate=off);--> statement-breakpoint
CREATE INDEX "idx_feature_rights_revoked" ON "conditions"."feature" USING btree ("id") WHERE "conditions"."feature"."tombstone_reason" = 'rights_revoked';--> statement-breakpoint
CREATE INDEX "idx_feature_id_bytes" ON "conditions"."feature" USING btree ("id" COLLATE "C");--> statement-breakpoint
CREATE INDEX "idx_feature_canonical_members" ON "conditions"."feature_canonical" USING gin ("member_ids") WITH (fastupdate=off);--> statement-breakpoint
CREATE INDEX "idx_feature_component_kind" ON "conditions"."feature_component" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_feature_component_external_ids" ON "conditions"."feature_component" USING gin ("external_ids" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "idx_feature_link_b" ON "conditions"."feature_link" USING btree ("b_id");--> statement-breakpoint
CREATE INDEX "idx_feature_revision_recorded" ON "conditions"."feature_revision" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_offer_subject" ON "conditions"."offer" USING btree ("subject_id","component_key");--> statement-breakpoint
CREATE INDEX "idx_offer_kind_valid_to" ON "conditions"."offer" USING btree ("kind","valid_to");--> statement-breakpoint
CREATE INDEX "idx_offer_geom" ON "conditions"."offer" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_offer_source" ON "conditions"."offer" USING btree ("source_id","id");--> statement-breakpoint
CREATE INDEX "idx_offer_canonical" ON "conditions"."offer" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "idx_offer_rights_revoked" ON "conditions"."offer" USING btree ("id") WHERE "conditions"."offer"."tombstone_reason" = 'rights_revoked';--> statement-breakpoint
CREATE INDEX "idx_offer_id_bytes" ON "conditions"."offer" USING btree ("id" COLLATE "C");--> statement-breakpoint
CREATE INDEX "idx_offer_revision_recorded" ON "conditions"."offer_revision" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_record_relation_to" ON "conditions"."record_relation" USING btree ("to_class","to_id");--> statement-breakpoint
CREATE INDEX "idx_situation_geom" ON "conditions"."situation" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_situation_kind_type" ON "conditions"."situation" USING btree ("kind","type");--> statement-breakpoint
CREATE INDEX "idx_situation_source" ON "conditions"."situation" USING btree ("source_id","id");--> statement-breakpoint
CREATE INDEX "idx_situation_canonical" ON "conditions"."situation" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "idx_situation_valid_to" ON "conditions"."situation" USING btree ("valid_to");--> statement-breakpoint
CREATE INDEX "idx_situation_expires" ON "conditions"."situation" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_situation_group" ON "conditions"."situation" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_situation_crowd_evidence" ON "conditions"."situation" USING btree ("origin","evidence_state") WHERE "conditions"."situation"."origin" = 'crowd';--> statement-breakpoint
CREATE INDEX "idx_situation_tombstoned" ON "conditions"."situation" USING btree ("tombstoned_at") WHERE "conditions"."situation"."tombstoned_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_situation_rights_revoked" ON "conditions"."situation" USING btree ("id") WHERE "conditions"."situation"."tombstone_reason" = 'rights_revoked';--> statement-breakpoint
CREATE INDEX "idx_situation_id_bytes" ON "conditions"."situation" USING btree ("id" COLLATE "C");--> statement-breakpoint
CREATE INDEX "idx_situation_effect_kind_valid_to" ON "conditions"."situation_effect" USING btree ("kind","valid_to");--> statement-breakpoint
CREATE INDEX "idx_situation_effect_geom" ON "conditions"."situation_effect" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_situation_revision_recorded" ON "conditions"."situation_revision" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_federation_lapsed_copy_source" ON "conditions"."federation_lapsed_copy" USING btree ("peer_instance_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_federation_outbox_record" ON "conditions"."federation_outbox" USING btree ("record_class","record_id","seq");--> statement-breakpoint
CREATE INDEX "idx_federation_outbox_cursor" ON "conditions"."federation_outbox" USING btree ("txid","seq");--> statement-breakpoint
CREATE INDEX "idx_federation_outbox_created_at" ON "conditions"."federation_outbox" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_federation_subscription_peer" ON "conditions"."federation_subscription" USING btree ("peer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_federation_subscription_target" ON "conditions"."federation_subscription" USING btree ("peer_id","delivery_mode",coalesce("inbox_url", '')) WHERE "conditions"."federation_subscription"."delivery_mode" <> 'sse';--> statement-breakpoint
CREATE INDEX "idx_osm_road_geom" ON "conditions"."osm_road" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_osm_road_highway" ON "conditions"."osm_road" USING btree ("highway");--> statement-breakpoint
CREATE INDEX "idx_osm_road_ref" ON "conditions"."osm_road" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "idx_road_segment_geom" ON "conditions"."road_segment" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_road_segment_way" ON "conditions"."road_segment" USING btree ("way_id");--> statement-breakpoint
CREATE INDEX "idx_road_segment_minzoom" ON "conditions"."road_segment" USING btree ("min_zoom");--> statement-breakpoint
CREATE INDEX "idx_segment_observation_segment" ON "conditions"."segment_observation" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "idx_segment_profile_segment" ON "conditions"."segment_profile" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "idx_segment_speed_los" ON "conditions"."segment_speed" USING btree ("los");--> statement-breakpoint
CREATE INDEX "idx_sensor_baseline_source_bucket" ON "conditions"."sensor_baseline" USING btree ("source","dow_bucket","tod_bucket");--> statement-breakpoint
CREATE INDEX "idx_sensor_segment_segment" ON "conditions"."sensor_segment" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "idx_source_poll_attempt_source_time" ON "conditions"."source_poll_attempt" USING btree ("source","attempted_at");--> statement-breakpoint
CREATE INDEX "idx_source_poll_attempt_time" ON "conditions"."source_poll_attempt" USING btree ("attempted_at","id");--> statement-breakpoint
CREATE INDEX "idx_spent_token_spent_at" ON "conditions"."spent_token" USING btree ("spent_at");