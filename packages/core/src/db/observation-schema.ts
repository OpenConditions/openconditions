import { ACCESS_MODES, EVIDENCE_STATES, enumCheckSql } from "@openconditions/model";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  smallint,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { conditionsSchema, geometry, tstz } from "./columns.js";

/**
 * The series registry and the reading in effect now, one row per subject,
 * property, qualifiers and source. `series_id` keys the compact history in
 * `conditions.observation`, which stores only what varies between readings;
 * `template` holds what does not (location, subject, qualifiers, provenance
 * without the raw reference), so a history row reads back as a whole record.
 * Crowd rows (source `crowd`) and the fused row (source `@fused`) sit beside
 * the per-source rows. A crowd row carries the evidence summary of the report
 * it holds, materialised from its `report_evidence` ledger as a crowd
 * situation's is. Created with `fillfactor = 70` (in the custom
 * migration): nothing indexes `value_num`, `record` or the times, so the
 * per-minute updates of a flow series stay HOT.
 */
export const observationLatest = conditionsSchema.table(
  "observation_latest",
  {
    seriesId: bigserial("series_id", { mode: "number" }).primaryKey(),
    subjectKey: text("subject_key").notNull(),
    property: text("property").notNull(),
    qualifierKey: text("qualifier_key").notNull().default(""),
    sourceId: text("source_id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    featureId: text("feature_id"),
    componentKey: text("component_key"),
    situationId: text("situation_id"),
    geom: geometry("geom"),
    record: jsonb("record").notNull(),
    template: jsonb("template").notNull(),
    accessMode: text("access_mode").notNull(),
    resultType: text("result_type").notNull(),
    valueNum: doublePrecision("value_num"),
    valueMoney: numeric("value_money", { precision: 14, scale: 4 }),
    valueText: text("value_text"),
    unit: text("unit"),
    currency: text("currency"),
    effectiveFrom: tstz("effective_from").notNull(),
    effectiveUntil: tstz("effective_until"),
    sinceAt: tstz("since_at").notNull(),
    fusedFrom: text("fused_from").array(),
    evidenceState: text("evidence_state"),
    confidenceScore: doublePrecision("confidence_score"),
    corroborations: integer("corroborations").notNull().default(0),
    expiresAt: tstz("expires_at"),
    retentionDays: smallint("retention_days"),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("observation_latest_series").on(t.subjectKey, t.property, t.qualifierKey, t.sourceId),
    check(
      "observation_latest_access_mode_enum",
      sql.raw(enumCheckSql("access_mode", ACCESS_MODES)),
    ),
    check(
      "observation_latest_evidence_state_enum",
      sql.raw(`evidence_state IS NULL OR ${enumCheckSql("evidence_state", EVIDENCE_STATES)}`),
    ),
    index("idx_observation_latest_geom").using("gist", t.geom),
    index("idx_observation_latest_property").on(t.property),
    index("idx_observation_latest_property_text").on(t.property, t.valueText),
    index("idx_observation_latest_component").on(t.featureId, t.componentKey),
    index("idx_observation_latest_fuel_price")
      .on(t.valueMoney)
      .where(sql`${t.property} = 'fuel.price'`),
    index("idx_observation_latest_expires").on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
    // A crowd report is found by its record id: votes, replays and re-keying name it.
    index("idx_observation_latest_crowd_record")
      .on(sql`(${t.record} ->> 'id')`)
      .where(sql`${t.sourceId} = 'crowd'`),
  ],
);

/** Hourly aggregates of a series: count, extremes, mean and, where declared, a histogram. */
export const observationRollupHourly = conditionsSchema.table(
  "observation_rollup_hourly",
  {
    seriesId: bigint("series_id", { mode: "number" }).notNull(),
    hourUtc: tstz("hour_utc").notNull(),
    sampleCount: integer("sample_count").notNull(),
    bins: smallint("bins").array(),
    counts: integer("counts").array(),
    min: doublePrecision("min").notNull(),
    max: doublePrecision("max").notNull(),
    mean: doublePrecision("mean").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seriesId, t.hourUtc] }),
    foreignKey({
      name: "observation_rollup_hourly_series_fk",
      columns: [t.seriesId],
      foreignColumns: [observationLatest.seriesId],
    }).onDelete("cascade"),
    index("idx_observation_rollup_hourly_hour").on(t.hourUtc),
  ],
);

/** Daily aggregates of slow series (fuel prices). */
export const observationRollupDaily = conditionsSchema.table(
  "observation_rollup_daily",
  {
    seriesId: bigint("series_id", { mode: "number" }).notNull(),
    dayUtc: date("day_utc").notNull(),
    sampleCount: integer("sample_count").notNull(),
    min: doublePrecision("min").notNull(),
    max: doublePrecision("max").notNull(),
    mean: doublePrecision("mean").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seriesId, t.dayUtc] }),
    foreignKey({
      name: "observation_rollup_daily_series_fk",
      columns: [t.seriesId],
      foreignColumns: [observationLatest.seriesId],
    }).onDelete("cascade"),
    index("idx_observation_rollup_daily_day").on(t.dayUtc),
  ],
);

/** Where each rollup period has been aggregated up to (exclusive). */
export const observationRollupProgress = conditionsSchema.table("observation_rollup_progress", {
  period: text("period").primaryKey(),
  finalizedBefore: tstz("finalized_before").notNull(),
});
