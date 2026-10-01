import { ACCESS_MODES, enumCheckSql, SOURCE_TIERS } from "@openconditions/model";
import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, text } from "drizzle-orm/pg-core";
import { conditionsSchema, tstz } from "./columns.js";

/**
 * The feed catalogue as the database sees it: one row per source the ingest
 * service has loaded, refreshed at every boot. SQL that needs a source's
 * rights, tier, licence or freshness window joins here. Rows of sources no
 * longer loaded stay, inactive, because their records still name them; no
 * record table holds a foreign key to it, since crowd and peer records carry
 * source ids no local catalogue knows.
 */
export const source = conditionsSchema.table(
  "source",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    format: text("format").notNull(),
    produces: text("produces").notNull(),
    accessMode: text("access_mode").notNull(),
    tier: text("tier").notNull(),
    country: text("country").notNull(),
    subdivision: text("subdivision"),
    operator: text("operator").notNull(),
    license: text("license").notNull(),
    licenseUrl: text("license_url"),
    attribution: text("attribution").notNull(),
    rights: jsonb("rights"),
    cadenceSec: integer("cadence_sec").notNull(),
    freshnessWindowSec: integer("freshness_window_sec").notNull(),
    rawRetention: text("raw_retention"),
    extrasAllow: text("extras_allow").array().notNull().default(sql`'{}'::text[]`),
    extrasFederate: boolean("extras_federate").notNull().default(false),
    laneNumbering: text("lane_numbering"),
    parentSourceId: text("parent_source_id"),
    policyIds: text("policy_ids").array(),
    selectionState: text("selection_state"),
    active: boolean("active").notNull().default(true),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("source_access_mode_enum", sql.raw(enumCheckSql("access_mode", ACCESS_MODES))),
    check("source_tier_enum", sql.raw(enumCheckSql("tier", SOURCE_TIERS))),
    check("source_produces_enum", sql`${t.produces} IN ('events', 'flow')`),
  ],
);
