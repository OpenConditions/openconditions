import {
  ACCESS_MODES,
  APPLICABILITY_KINDS,
  CERTAINTIES,
  COMPLIANCE,
  EVIDENCE_STATES,
  enumCheckSql,
  LIFECYCLES,
  LINK_METHODS,
  LINK_STATUSES,
  NORMALIZATION,
  ORIGINS,
  PRIVACY_CLASSES,
  RECORD_CLASSES,
  RELATIONS,
  SEVERITY_LABELS,
  TEMPORALITIES,
  TOMBSTONE_REASONS,
  VALIDITY_STATUSES,
} from "@openconditions/model";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  smallint,
  text,
} from "drizzle-orm/pg-core";
import { conditionsSchema, geometry, geometryPoint, tstz } from "./columns.js";

/** The record classes that keep a row and revisions per record; observations are series. */
export type RevisionedClass = "situation" | "feature" | "offer";

/** A CHECK body that also lets the column be null. */
const nullableEnum = (column: string, values: readonly string[]): SQL =>
  sql.raw(`${column} IS NULL OR ${enumCheckSql(column, values)}`);

/**
 * The kernel columns every class table promotes from its `record`: identity,
 * classification, provenance, freshness, revision and tombstone. `record` is
 * the stored record itself (without the evidence summary, which is
 * materialised beside it) and the only thing reads return; the columns exist
 * for filters, joins and indexes and are derived from it by the writer.
 */
function kernelColumns() {
  return {
    id: text("id").primaryKey(),
    record: jsonb("record").notNull(),
    canonicalId: text("canonical_id").notNull(),
    kind: text("kind").notNull(),
    type: text("type"),
    subtype: text("subtype"),
    domain: text("domain").notNull(),
    temporality: text("temporality").notNull(),
    sourceId: text("source_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    origin: text("origin").notNull(),
    accessMode: text("access_mode").notNull(),
    privacyClass: text("privacy_class").notNull(),
    instanceId: text("instance_id").notNull(),
    revision: integer("revision").notNull(),
    recordedAt: tstz("recorded_at").notNull(),
    contentHash: text("content_hash").notNull(),
    fetchedAt: tstz("fetched_at").notNull(),
    expiresAt: tstz("expires_at"),
    geom: geometry("geom"),
    country: text("country"),
    subdivision: text("subdivision"),
    tombstoneReason: text("tombstone_reason"),
    tombstonedAt: tstz("tombstoned_at"),
    /**
     * When this instance first stored the record, by the database clock that
     * also stamps a source's `restricted_since`; never rewritten.
     */
    createdAt: tstz("created_at").notNull().defaultNow(),
  };
}

/** The kernel-closed CHECKs of a class table, named after it. */
function kernelChecks(table: string) {
  return [
    check(`${table}_temporality_enum`, sql.raw(enumCheckSql("temporality", TEMPORALITIES))),
    check(`${table}_origin_enum`, sql.raw(enumCheckSql("origin", ORIGINS))),
    check(`${table}_access_mode_enum`, sql.raw(enumCheckSql("access_mode", ACCESS_MODES))),
    check(`${table}_privacy_class_enum`, sql.raw(enumCheckSql("privacy_class", PRIVACY_CLASSES))),
    check(`${table}_tombstone_reason_enum`, nullableEnum("tombstone_reason", TOMBSTONE_REASONS)),
    check(
      `${table}_tombstone_complete`,
      sql.raw("(tombstone_reason IS NULL) = (tombstoned_at IS NULL)"),
    ),
    check(`${table}_revision_positive`, sql.raw("revision > 0")),
  ];
}

/** A class's revision history: every content change, with what changed. */
function revisionTable(table: string, parentColumn: string, parent: () => AnyPgColumn) {
  return conditionsSchema.table(
    `${table}_revision`,
    {
      parentId: text(parentColumn).notNull().references(parent, { onDelete: "cascade" }),
      revision: integer("revision").notNull(),
      recordedAt: tstz("recorded_at").notNull(),
      changeKinds: text("change_kinds").array().notNull(),
      snapshot: jsonb("snapshot").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.parentId, t.revision] }),
      index(`idx_${table}_revision_recorded`).on(t.recordedAt),
    ],
  );
}

/** Bounded-in-time conditions: incidents, works, closures, alerts, hazards. */
export const situation = conditionsSchema.table(
  "situation",
  {
    ...kernelColumns(),
    severity: text("severity").notNull(),
    severityLevel: smallint("severity_level"),
    certainty: text("certainty").notNull(),
    planned: boolean("planned").notNull(),
    validityStatus: text("validity_status").notNull(),
    validFrom: tstz("valid_from"),
    validTo: tstz("valid_to"),
    groupId: text("group_id"),
    evidenceState: text("evidence_state"),
    confidenceScore: doublePrecision("confidence_score"),
    routingEligible: boolean("routing_eligible").notNull().default(false),
    corroborations: integer("corroborations").notNull().default(0),
    flaggedAt: tstz("flagged_at"),
  },
  (t) => [
    ...kernelChecks("situation"),
    check("situation_severity_enum", sql.raw(enumCheckSql("severity", SEVERITY_LABELS))),
    check(
      "situation_severity_level_range",
      sql`${t.severityLevel} IS NULL OR ${t.severityLevel} BETWEEN 1 AND 5`,
    ),
    check("situation_certainty_enum", sql.raw(enumCheckSql("certainty", CERTAINTIES))),
    check(
      "situation_validity_status_enum",
      sql.raw(enumCheckSql("validity_status", VALIDITY_STATUSES)),
    ),
    check("situation_evidence_state_enum", nullableEnum("evidence_state", EVIDENCE_STATES)),
    index("idx_situation_geom").using("gist", t.geom),
    index("idx_situation_kind_type").on(t.kind, t.type),
    // A source's records, paged by id (the federation reconcile).
    index("idx_situation_source").on(t.sourceId, t.id),
    index("idx_situation_canonical").on(t.canonicalId),
    index("idx_situation_valid_to").on(t.validTo),
    index("idx_situation_expires").on(t.expiresAt),
    index("idx_situation_group").on(t.groupId),
    index("idx_situation_crowd_evidence")
      .on(t.origin, t.evidenceState)
      .where(sql`${t.origin} = 'crowd'`),
    index("idx_situation_tombstoned").on(t.tombstonedAt).where(sql`${t.tombstonedAt} IS NOT NULL`),
  ],
);

/**
 * One row per effect of a situation, phase effects included, so routing and
 * tiles can join effects to graph spans. `value` is the effect itself.
 */
export const situationEffect = conditionsSchema.table(
  "situation_effect",
  {
    situationId: text("situation_id")
      .notNull()
      .references(() => situation.id, { onDelete: "cascade" }),
    effectId: text("effect_id").notNull(),
    phaseId: text("phase_id").notNull().default(""),
    kind: text("kind").notNull(),
    applicabilityKind: text("applicability_kind").notNull(),
    normalization: text("normalization").notNull(),
    compliance: text("compliance").notNull(),
    direction: text("direction"),
    validFrom: tstz("valid_from"),
    validTo: tstz("valid_to"),
    geom: geometry("geom"),
    value: jsonb("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.situationId, t.effectId] }),
    check(
      "situation_effect_applicability_enum",
      sql.raw(enumCheckSql("applicability_kind", APPLICABILITY_KINDS)),
    ),
    check(
      "situation_effect_normalization_enum",
      sql.raw(enumCheckSql("normalization", NORMALIZATION)),
    ),
    check("situation_effect_compliance_enum", sql.raw(enumCheckSql("compliance", COMPLIANCE))),
    index("idx_situation_effect_kind_valid_to").on(t.kind, t.validTo),
    index("idx_situation_effect_geom").using("gist", t.geom),
  ],
);

export const situationRevision = revisionTable("situation", "situation_id", () => situation.id);

/** Persistent things: sites, signs, stations, crossings, structures. */
export const feature = conditionsSchema.table(
  "feature",
  {
    ...kernelColumns(),
    lifecycle: text("lifecycle").notNull(),
  },
  (t) => [
    ...kernelChecks("feature"),
    check("feature_lifecycle_enum", sql.raw(enumCheckSql("lifecycle", LIFECYCLES))),
    index("idx_feature_geom").using("gist", t.geom),
    index("idx_feature_kind_type").on(t.kind, t.type),
    index("idx_feature_source").on(t.sourceId, t.id),
    index("idx_feature_canonical").on(t.canonicalId),
    index("idx_feature_kind_lifecycle").on(t.kind, t.lifecycle),
    // Linking finds the features that share an external id with a written one,
    // one id at a time, often in the transaction that just wrote them: entries
    // go into the index directly, as a pending list would be scanned whole on
    // every lookup.
    index("idx_feature_external_ids")
      .using("gin", sql`(${t.record} -> 'externalIds') jsonb_path_ops`)
      .with({ fastupdate: "off" }),
  ],
);

/**
 * A feature's components, one row each, for joins on a component's kind,
 * details or ids (fuel grade, connector standard, EVSE id). The component
 * also rides inside its feature's `record`.
 */
export const featureComponent = conditionsSchema.table(
  "feature_component",
  {
    featureId: text("feature_id")
      .notNull()
      .references(() => feature.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    parentKey: text("parent_key"),
    kind: text("kind").notNull(),
    lifecycle: text("lifecycle"),
    position: geometryPoint("position"),
    externalIds: jsonb("external_ids"),
    details: jsonb("details").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.featureId, t.key] }),
    check("feature_component_lifecycle_enum", nullableEnum("lifecycle", LIFECYCLES)),
    index("idx_feature_component_kind").on(t.kind),
    index("idx_feature_component_external_ids").using("gin", t.externalIds.op("jsonb_path_ops")),
  ],
);

export const featureRevision = revisionTable("feature", "feature_id", () => feature.id);

/** A decided or proposed identity link between two per-source features. */
export const featureLink = conditionsSchema.table(
  "feature_link",
  {
    aId: text("a_id").notNull(),
    bId: text("b_id").notNull(),
    method: text("method").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    status: text("status").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: tstz("decided_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.aId, t.bId] }),
    check("feature_link_ordered", sql`${t.aId} < ${t.bId}`),
    check("feature_link_method_enum", sql.raw(enumCheckSql("method", LINK_METHODS))),
    check("feature_link_status_enum", sql.raw(enumCheckSql("status", LINK_STATUSES))),
    index("idx_feature_link_b").on(t.bId),
  ],
);

/**
 * The canonical view: one row per cluster of linked features, a lone feature
 * included. `components` is the cluster's canonical component set
 * (`canonicalComponents`): each canonical key with the member components it
 * stands for, which crowd landing and the fused rows map subjects through.
 * Clusters are found one member at a time (`clustersHolding`), so the member
 * index takes entries directly: a pending list of fresh entries would be
 * scanned whole on every lookup, quadratic over a poll's clusters.
 */
export const featureCanonical = conditionsSchema.table(
  "feature_canonical",
  {
    canonicalFeatureId: text("canonical_feature_id").primaryKey(),
    survivorId: text("survivor_id").notNull(),
    memberIds: text("member_ids").array().notNull(),
    mergedSources: jsonb("merged_sources"),
    components: jsonb("components").notNull().default(sql`'[]'::jsonb`),
    computedAt: tstz("computed_at").notNull(),
  },
  (t) => [
    index("idx_feature_canonical_members").using("gin", t.memberIds).with({ fastupdate: "off" }),
  ],
);

/** Structured tariffs attached to a feature or component. */
export const offer = conditionsSchema.table(
  "offer",
  {
    ...kernelColumns(),
    subjectClass: text("subject_class").notNull(),
    subjectId: text("subject_id").notNull(),
    componentKey: text("component_key"),
    currency: text("currency").notNull(),
    validFrom: tstz("valid_from"),
    validTo: tstz("valid_to"),
    minPrice: numeric("min_price", { precision: 14, scale: 4 }),
    maxPrice: numeric("max_price", { precision: 14, scale: 4 }),
  },
  (t) => [
    ...kernelChecks("offer"),
    check("offer_subject_class_enum", sql.raw(enumCheckSql("subject_class", RECORD_CLASSES))),
    index("idx_offer_subject").on(t.subjectId, t.componentKey),
    index("idx_offer_kind_valid_to").on(t.kind, t.validTo),
    index("idx_offer_geom").using("gist", t.geom),
    index("idx_offer_source").on(t.sourceId, t.id),
    index("idx_offer_canonical").on(t.canonicalId),
  ],
);

export const offerRevision = revisionTable("offer", "offer_id", () => offer.id);

/**
 * Every record's `relations`, materialised so "what points at this record"
 * is an index lookup. `component_key` is '' when the target is a whole record.
 */
export const recordRelation = conditionsSchema.table(
  "record_relation",
  {
    fromClass: text("from_class").notNull(),
    fromId: text("from_id").notNull(),
    relation: text("relation").notNull(),
    toClass: text("to_class").notNull(),
    toId: text("to_id").notNull(),
    componentKey: text("component_key").notNull().default(""),
  },
  (t) => [
    primaryKey({
      name: "record_relation_pk",
      columns: [t.fromClass, t.fromId, t.relation, t.toClass, t.toId, t.componentKey],
    }),
    check("record_relation_from_class_enum", sql.raw(enumCheckSql("from_class", RECORD_CLASSES))),
    check("record_relation_to_class_enum", sql.raw(enumCheckSql("to_class", RECORD_CLASSES))),
    check("record_relation_relation_enum", sql.raw(enumCheckSql("relation", RELATIONS))),
    index("idx_record_relation_to").on(t.toClass, t.toId),
  ],
);
