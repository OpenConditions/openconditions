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
	CONSTRAINT "feature_link_ordered" CHECK ("conditions"."feature_link"."a_id" < "conditions"."feature_link"."b_id"),
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
	CONSTRAINT "situation_severity_enum" CHECK ("severity" IN ('minor', 'moderate', 'major', 'critical', 'unknown')),
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
ALTER TABLE "conditions"."feature_component" ADD CONSTRAINT "feature_component_feature_id_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "conditions"."feature"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."feature_revision" ADD CONSTRAINT "feature_revision_feature_id_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "conditions"."feature"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."offer_revision" ADD CONSTRAINT "offer_revision_offer_id_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "conditions"."offer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."situation_effect" ADD CONSTRAINT "situation_effect_situation_id_situation_id_fk" FOREIGN KEY ("situation_id") REFERENCES "conditions"."situation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions"."situation_revision" ADD CONSTRAINT "situation_revision_situation_id_situation_id_fk" FOREIGN KEY ("situation_id") REFERENCES "conditions"."situation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_feature_geom" ON "conditions"."feature" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_feature_kind_type" ON "conditions"."feature" USING btree ("kind","type");--> statement-breakpoint
CREATE INDEX "idx_feature_source" ON "conditions"."feature" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_feature_canonical" ON "conditions"."feature" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "idx_feature_kind_lifecycle" ON "conditions"."feature" USING btree ("kind","lifecycle");--> statement-breakpoint
CREATE INDEX "idx_feature_canonical_members" ON "conditions"."feature_canonical" USING gin ("member_ids");--> statement-breakpoint
CREATE INDEX "idx_feature_component_kind" ON "conditions"."feature_component" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_feature_component_external_ids" ON "conditions"."feature_component" USING gin ("external_ids" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "idx_feature_link_b" ON "conditions"."feature_link" USING btree ("b_id");--> statement-breakpoint
CREATE INDEX "idx_feature_revision_recorded" ON "conditions"."feature_revision" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_offer_subject" ON "conditions"."offer" USING btree ("subject_id","component_key");--> statement-breakpoint
CREATE INDEX "idx_offer_kind_valid_to" ON "conditions"."offer" USING btree ("kind","valid_to");--> statement-breakpoint
CREATE INDEX "idx_offer_geom" ON "conditions"."offer" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_offer_source" ON "conditions"."offer" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_offer_canonical" ON "conditions"."offer" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "idx_offer_revision_recorded" ON "conditions"."offer_revision" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_record_relation_to" ON "conditions"."record_relation" USING btree ("to_class","to_id");--> statement-breakpoint
CREATE INDEX "idx_situation_geom" ON "conditions"."situation" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_situation_kind_type" ON "conditions"."situation" USING btree ("kind","type");--> statement-breakpoint
CREATE INDEX "idx_situation_source" ON "conditions"."situation" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_situation_canonical" ON "conditions"."situation" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "idx_situation_valid_to" ON "conditions"."situation" USING btree ("valid_to");--> statement-breakpoint
CREATE INDEX "idx_situation_expires" ON "conditions"."situation" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_situation_group" ON "conditions"."situation" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_situation_crowd_evidence" ON "conditions"."situation" USING btree ("origin","evidence_state") WHERE "conditions"."situation"."origin" = 'crowd';--> statement-breakpoint
CREATE INDEX "idx_situation_tombstoned" ON "conditions"."situation" USING btree ("tombstoned_at") WHERE "conditions"."situation"."tombstoned_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_situation_effect_kind_valid_to" ON "conditions"."situation_effect" USING btree ("kind","valid_to");--> statement-breakpoint
CREATE INDEX "idx_situation_effect_geom" ON "conditions"."situation_effect" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_situation_revision_recorded" ON "conditions"."situation_revision" USING btree ("recorded_at");