import { ACCESS_MODES, EVIDENCE_STATES, enumCheckSql } from "@openconditions/model";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
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
 * The reading in effect is kept the same way: `reading` is the stored record
 * minus its template (`readingOf`), and the record is
 * `conditions.observation_record(template, reading)` (`recordOf` in code).
 * The template is stored out of line (`STORAGE EXTERNAL`,
 * `toast_tuple_target = 1200`, the reading `STORAGE MAIN`) and written only
 * when `template_hash` changes, so an update of a reading rewrites a few
 * hundred bytes, not the record.
 * Crowd rows (source `crowd`) and the fused rows sit beside the per-source
 * rows. A subject's `@fused` row is fused from every candidate; when one of
 * its contributors is not public, a `@fused-public` row holds the fusion of
 * the public candidates (when there is one). `fused_public` is true on the
 * fused row the public scope reads (an all-public `@fused`, or the
 * `@fused-public` beside it), false on a `@fused` row with a contributor
 * that is not public, and null on every other row. A crowd row carries the
 * evidence summary of the report it holds, materialised from its `report_evidence` ledger as a crowd
 * situation's is. The custom migrations set `fillfactor = 50`, and nothing
 * indexes `value_num`, `reading` or the effective times: the per-minute
 * updates of a quantity series without an expiry (every flow reading) stay
 * HOT. A category or boolean series (`value_text`) and one with an expiry
 * (`expires_at`) are indexed by what they change; they change far less often.
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
    reading: jsonb("reading").notNull(),
    template: jsonb("template").notNull(),
    templateHash: text("template_hash").notNull(),
    /** A crowd row's record id (null on every other row, so no feed update changes an indexed value). */
    crowdRecordId: text("crowd_record_id"),
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
    /** A fused row's contributing sources (their rows' `source_id`), in contributor order without repeats. */
    fusedSources: text("fused_sources").array(),
    fusedPublic: boolean("fused_public"),
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
    // Leads with the property, so it serves a filter by property alone too.
    index("idx_observation_latest_property_text").on(t.property, t.valueText),
    // A poll compares its readings with every series of its source; the
    // federation reconcile pages them by series id. Neither column changes
    // on a reading's update, which stays heap-only.
    index("idx_observation_latest_source").on(t.sourceId, t.seriesId),
    index("idx_observation_latest_component").on(t.featureId, t.componentKey),
    index("idx_observation_latest_fuel_price")
      .on(t.valueMoney)
      .where(sql`${t.property} = 'fuel.price'`),
    index("idx_observation_latest_expires").on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
    // Reads of readings since an instant (the last day's fire pixels). BRIN
    // summarizes block ranges, so a reading's update stays heap-only; a btree
    // on what every reading changes would not.
    index("idx_observation_latest_effective_brin").using("brin", t.effectiveFrom),
    // A crowd report is found by its record id: votes, replays and re-keying
    // name it. Indexing an expression over `reading` would change with every
    // reading of every series and keep their updates from being HOT.
    index("idx_observation_latest_crowd_record")
      .on(t.crowdRecordId)
      .where(sql`${t.crowdRecordId} IS NOT NULL`),
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
