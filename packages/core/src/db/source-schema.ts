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
    /** What the source publishes, from its domain's product list. */
    product: text("product").notNull(),
    accessMode: text("access_mode").notNull(),
    tier: text("tier").notNull(),
    /** Null for a source of no single country (`eu`, `global`). */
    country: text("country"),
    subdivision: text("subdivision"),
    operator: text("operator").notNull(),
    license: text("license").notNull(),
    licenseUrl: text("license_url"),
    attribution: text("attribution").notNull(),
    rights: jsonb("rights"),
    /**
     * Withheld from the public scope: share-alike, or redistribution not
     * affirmatively granted by the source's effective rights. Its records
     * are stored and fused like any other, but only operator reads see them,
     * and they never reach federation or the archive.
     */
    restricted: boolean("restricted").notNull().default(false),
    /**
     * When `restricted` last turned true: the catalogue sync sets it on the
     * flip, or at the source's creation when it is added restricted, and
     * clears it when the source turns public. A record stored before it may
     * have reached a federation peer while the source was public; one stored
     * since never did (`federation_was_shared`). Null while public.
     */
    restrictedSince: tstz("restricted_since"),
    /**
     * The `restricted` flag, tier and licence registry classification
     * (`publicLicenseClassification`) this source's fused rows were last
     * refreshed under, set once every canonical feature it has readings on
     * has been refreshed; null until then. Where they differ from the
     * current ones, the ingest service's boot refreshes those fusions.
     */
    fusionRestricted: boolean("fusion_restricted"),
    fusionTier: text("fusion_tier"),
    fusionLicenses: text("fusion_licenses"),
    /**
     * The `restricted` flag the federation outbox last reflected for this
     * source's records: set once a flip's deletes (turned restricted) or
     * creates (turned public) are all journalled. Null for a source added
     * since, which is taken as in sync with its flag. Where it differs, the
     * ingest service's boot reconciles the outbox (`reconcileFederation`).
     */
    federationRestricted: boolean("federation_restricted"),
    /**
     * A reconcile has journalled part of this source's records and not yet
     * settled: the next boot reconciles it toward its flag then, even when
     * a flip back made the basis match it again.
     */
    federationPending: boolean("federation_pending").notNull().default(false),
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
  () => [
    check("source_access_mode_enum", sql.raw(enumCheckSql("access_mode", ACCESS_MODES))),
    check("source_tier_enum", sql.raw(enumCheckSql("tier", SOURCE_TIERS))),
  ],
);
