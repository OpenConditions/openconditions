import { enumCheckSql } from "@openconditions/model";
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, primaryKey, text } from "drizzle-orm/pg-core";
import { conditionsSchema, tstz } from "./columns.js";

/**
 * How long a raw payload is kept: a situation feed's longest, an observation
 * feed's shorter, a reference table's by version, and `hot` (the last 48
 * hours only) for a source whose terms do not affirm retention.
 */
export const RAW_TIERS = ["situation", "observation", "reference", "hot"] as const;
export type RawTier = (typeof RAW_TIERS)[number];

/**
 * The index of archived raw payloads: one row per distinct decoded response
 * of a source, the blob itself on disk under `storage_key`. Eviction deletes
 * the blob and sets `evicted_at`; the row stays, so a record's `rawRef` keeps
 * naming what it was read from. `base_hash` marks a delta patch against
 * another payload (unused until delta chains exist).
 */
export const rawPayload = conditionsSchema.table(
  "raw_payload",
  {
    sourceId: text("source_id").notNull(),
    hash: text("hash").notNull(),
    urlKey: text("url_key").notNull(),
    fetchId: bigint("fetch_id", { mode: "number" }),
    mediaType: text("media_type"),
    bytesRaw: bigint("bytes_raw", { mode: "number" }).notNull(),
    bytesStored: bigint("bytes_stored", { mode: "number" }).notNull(),
    firstFetchedAt: tstz("first_fetched_at").notNull(),
    lastSeenAt: tstz("last_seen_at").notNull(),
    seenCount: integer("seen_count").notNull().default(1),
    tier: text("tier").notNull(),
    pinnedReason: text("pinned_reason"),
    storageKey: text("storage_key").notNull(),
    baseHash: text("base_hash"),
    evictedAt: tstz("evicted_at"),
  },
  (t) => [
    primaryKey({ name: "raw_payload_pk", columns: [t.sourceId, t.hash] }),
    check("raw_payload_tier_enum", sql.raw(enumCheckSql("tier", RAW_TIERS))),
    index("idx_raw_payload_source_time").on(t.sourceId, t.firstFetchedAt),
    index("idx_raw_payload_tier_seen").on(t.tier, t.lastSeenAt).where(sql`${t.evictedAt} IS NULL`),
    index("idx_raw_payload_base").on(t.sourceId, t.baseHash).where(sql`${t.baseHash} IS NOT NULL`),
  ],
);
