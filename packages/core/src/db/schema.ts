import {
  bigserial,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

const conditionsSchema = pgSchema("conditions");

/** PostGIS geometry column. Requires the `postgis` extension (created by the
 * first migration, which drizzle-kit cannot model on its own). */
const geometry = customType<{ data: string }>({
  dataType() {
    return "geometry(Geometry, 4326)";
  },
});

/**
 * The single generic store for every domain (roads/transit/places/crowd).
 * This Drizzle definition is the SCHEMA SOURCE OF TRUTH — drizzle-kit generates
 * the versioned SQL migrations in `packages/core/drizzle/` from it.
 */
export const observations = conditionsSchema.table(
  "observations",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    sourceFormat: text("source_format").notNull(),
    domain: text("domain").notNull(),
    kind: text("kind").notNull(),

    type: text("type"),
    subtype: text("subtype"),
    category: text("category"),
    severity: text("severity"),
    severitySource: text("severity_source"),
    headline: text("headline"),
    description: text("description"),
    label: text("label"),

    metric: text("metric"),
    value: doublePrecision("value"),
    level: text("level"),
    unit: text("unit"),
    aggregation: text("aggregation"),

    status: text("status").notNull().default("active"),
    geom: geometry("geom").notNull(),
    subject: jsonb("subject"),
    attributes: jsonb("attributes"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    schedule: jsonb("schedule"),
    confidence: text("confidence"),
    isForecast: boolean("is_forecast").notNull().default(false),
    relatedIds: jsonb("related_ids"),
    origin: jsonb("origin").notNull(),
    dataUpdatedAt: timestamp("data_updated_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isStale: boolean("is_stale").notNull().default(false),
    // fetched_at + freshness window; read derives is_stale as now() > stale_after.
    staleAfter: timestamp("stale_after", { withTimezone: true }),
  },
  (t) => [
    index("idx_conditions_obs_geom").using("gist", t.geom),
    index("idx_conditions_obs_domain").on(t.domain),
    index("idx_conditions_obs_dom_type").on(t.domain, t.type),
    index("idx_conditions_obs_severity").on(t.severity),
    index("idx_conditions_obs_metric").on(t.metric),
    index("idx_conditions_obs_valid_to").on(t.validTo),
    index("idx_conditions_obs_expires").on(t.expiresAt),
    index("idx_conditions_obs_subject").using("gin", t.subject),
    index("idx_conditions_obs_source").on(t.source),
  ]
);

/**
 * Append-only per-sensor speed history. One row per flow observation that
 * carries a speed. `dow`/`tod_hour` are UTC (getUTCDay / getUTCHours).
 * TODO: local-timezone bucketing is a future refinement (MVP is UTC).
 */
export const sensorSpeedSample = conditionsSchema.table(
  "sensor_speed_sample",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sensorKey: text("sensor_key").notNull(),
    source: text("source").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    speedKph: doublePrecision("speed_kph").notNull(),
    dow: smallint("dow").notNull(),
    todHour: smallint("tod_hour").notNull(),
    geom: geometry("geom").notNull(),
  },
  (t) => [
    index("idx_sensor_sample_key_bucket").on(t.sensorKey, t.dow, t.todHour),
    index("idx_sensor_sample_observed").on(t.observedAt),
    unique("uq_sensor_sample_key_observed").on(t.sensorKey, t.observedAt),
  ]
);

/**
 * Derived / native / osm free-flow baselines, upserted. `dow_bucket`:
 * 0 = weekday (Mon–Fri), 1 = weekend, -1 = per-sensor overall. `tod_bucket`:
 * 0–23 hour, -1 = overall. `method`: 'native' | 'derived' | 'osm_maxspeed'.
 */
export const sensorBaseline = conditionsSchema.table(
  "sensor_baseline",
  {
    sensorKey: text("sensor_key").notNull(),
    source: text("source").notNull(),
    dowBucket: smallint("dow_bucket").notNull(),
    todBucket: smallint("tod_bucket").notNull(),
    freeFlowKph: doublePrecision("free_flow_kph").notNull(),
    method: text("method").notNull(),
    sampleCount: integer("sample_count").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sensorKey, t.dowBucket, t.todBucket, t.method] }),
    index("idx_sensor_baseline_source_bucket").on(t.source, t.dowBucket, t.todBucket),
  ]
);
