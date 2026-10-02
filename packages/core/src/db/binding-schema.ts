import { enumCheckSql, RECORD_CLASSES } from "@openconditions/model";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { conditionsSchema } from "./columns.js";

/**
 * One row per thing the resolver attempted to place on the segment spine: a
 * record's own location (`effect_id` '') or one of its effects that names a
 * location of its own. `status` records every outcome, bound or not, so
 * per-source quality is measurable. `record_revision` and `graph_generation`
 * fence a result to the record and graph it was computed from; `geom_hash`
 * lets an unchanged input skip rebinding. No foreign key: the record classes
 * are separate tables, and the writer removes a purged record's bindings.
 */
export const recordBinding = conditionsSchema.table(
  "record_binding",
  {
    recordClass: text("record_class").notNull(),
    recordId: text("record_id").notNull(),
    effectId: text("effect_id").notNull().default(""),
    status: text("status").notNull(),
    confidence: doublePrecision("confidence"),
    directionMode: text("direction_mode").notNull(),
    candidateCount: integer("candidate_count").notNull().default(0),
    alternativeConfidence: doublePrecision("alternative_confidence"),
    reason: text("reason"),
    resolverVersion: text("resolver_version").notNull(),
    geomHash: text("geom_hash").notNull(),
    recordRevision: integer("record_revision").notNull(),
    graphGeneration: text("graph_generation"),
    boundAt: timestamp("bound_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recordClass, t.recordId, t.effectId] }),
    check(
      "record_binding_record_class_enum",
      sql.raw(enumCheckSql("record_class", RECORD_CLASSES)),
    ),
    index("idx_record_binding_status").on(t.status),
  ],
);

/**
 * Durable binding work: a record whose revision changed waits here until the
 * binder has placed it (`effect_id` '' covers the record and its effects). A
 * resolver failure stays queued with bounded backoff. `record_revision`
 * fences a delayed worker from acknowledging work for a newer revision.
 */
export const bindingQueue = conditionsSchema.table(
  "binding_queue",
  {
    recordClass: text("record_class").notNull(),
    recordId: text("record_id").notNull(),
    effectId: text("effect_id").notNull().default(""),
    recordRevision: integer("record_revision").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.recordClass, t.recordId, t.effectId] }),
    index("idx_binding_queue_due").on(t.nextAttemptAt),
  ],
);

/**
 * The ordered spans of a bound location. Deliberately no foreign key to
 * `road_segment`: the weekly rebuild deletes and reinserts a region's segments
 * (ids stay stable), and a cascade would wipe every binding each week. The
 * rebuild re-binds and prunes orphans itself.
 */
export const recordSegment = conditionsSchema.table(
  "record_segment",
  {
    recordClass: text("record_class").notNull(),
    recordId: text("record_id").notNull(),
    effectId: text("effect_id").notNull().default(""),
    seq: smallint("seq").notNull(),
    segmentId: text("segment_id").notNull(),
    wayId: bigint("way_id", { mode: "number" }).notNull(),
    dir: text("dir").notNull(),
    startFraction: doublePrecision("start_fraction").notNull(),
    endFraction: doublePrecision("end_fraction").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recordClass, t.recordId, t.effectId, t.seq] }),
    index("idx_record_segment_segment").on(t.segmentId),
  ],
);
