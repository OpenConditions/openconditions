import { enumCheckSql, RECORD_CLASSES, SUB_CLAIM_TYPES } from "@openconditions/model";
import { sql } from "drizzle-orm";
import { bigserial, check, index, jsonb, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { conditionsSchema, geometryPoint } from "./columns.js";

/** What the evidence ledger records: a report, a vote, or an external resolution. */
export const EVIDENCE_KINDS = [
  "report",
  "confirm",
  "negate",
  "official_match",
  "reviewer_accept",
  "reviewer_reject",
] as const;

/**
 * A signed reaction to a record: a confirm, negate, or flag from one reporter
 * key. The id is the hash of the key and the claim's nonce, so a replayed vote
 * collides on it and the key never shows. The unique index enforces one
 * reaction per (record, component, key, type) so a key cannot stuff the
 * ballot on a single subject.
 */
export const subClaim = conditionsSchema.table(
  "sub_claim",
  {
    id: text("id").primaryKey(),
    subjectClass: text("subject_class").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectComponentKey: text("subject_component_key").notNull().default(""),
    claimType: text("claim_type").notNull(),
    keyId: text("key_id").notNull(),
    reason: text("reason"),
    geom: geometryPoint("geom"),
    signature: text("signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_sub_claim_subject_key_type").on(
      t.subjectClass,
      t.subjectId,
      t.subjectComponentKey,
      t.keyId,
      t.claimType,
    ),
    index("idx_sub_claim_key").on(t.keyId),
    check("sub_claim_claim_type_enum", sql.raw(enumCheckSql("claim_type", SUB_CLAIM_TYPES))),
    check("sub_claim_subject_class_enum", sql.raw(enumCheckSql("subject_class", RECORD_CLASSES))),
  ],
);

/**
 * The append-only, authoritative evidence ledger for a crowd record: one row
 * per admissible piece of evidence (report, confirm, negate, external
 * resolution). The record's evidence summary is a replayable projection of
 * these rows (`evidenceRowsToLedger` + `evaluateEvidence`). A confirm merged
 * from another report names it in `details.merged`, which is how a merged
 * report finds its survivor.
 */
export const reportEvidence = conditionsSchema.table(
  "report_evidence",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    recordClass: text("record_class").notNull(),
    recordId: text("record_id").notNull(),
    componentKey: text("component_key").notNull().default(""),
    evidenceKind: text("evidence_kind").notNull(),
    actorKeyId: text("actor_key_id"),
    sourceId: text("source_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("idx_report_evidence_record").on(t.recordClass, t.recordId, t.occurredAt),
    // Supports the per-key report-rate limiter's trailing-window count.
    index("idx_report_evidence_actor").on(t.actorKeyId, t.occurredAt),
    index("idx_report_evidence_merged")
      .on(sql`(${t.details} ->> 'merged')`)
      .where(sql`${t.details} ? 'merged'`),
    check("report_evidence_kind_enum", sql.raw(enumCheckSql("evidence_kind", EVIDENCE_KINDS))),
    check(
      "report_evidence_record_class_enum",
      sql.raw(enumCheckSql("record_class", RECORD_CLASSES)),
    ),
  ],
);
