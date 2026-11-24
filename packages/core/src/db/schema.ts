import { enumCheckSql, RECORD_CLASSES, TOMBSTONE_REASONS } from "@openconditions/model";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, conditionsSchema, geometry, sealedSecretCheck, xid8 } from "./columns.js";

/** A segment's level of service, worst last but `unknown`. */
export const SEGMENT_LOS = [
  "free_flow",
  "heavy",
  "queuing",
  "stationary",
  "blocked",
  "unknown",
] as const;

/** How a segment speed was obtained: measured on the segment, or propagated from a neighbour. */
export const SEGMENT_SPEED_CONFIDENCES = ["measured", "estimated"] as const;

/**
 * One row per feed source, updated on every poll cycle (including a 304/
 * unchanged no-op) so freshness and orphan-status can be derived from *when
 * the source last polled/succeeded* rather than from any individual row's
 * `fetched_at`. This is what lets a healthy feed sitting behind a 304 keep
 * its last-good records indefinitely instead of being swept as orphaned
 * after `ORPHAN_MAX_AGE_SEC` — a write leaves unchanged records untouched, so
 * a per-record freshness check would otherwise treat an unchanged-but-healthy
 * source as gone stale.
 */
export const sourceStatus = conditionsSchema.table("source_status", {
  source: text("source").primaryKey(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastNetworkSuccessAt: timestamp("last_network_success_at", { withTimezone: true }),
  freshnessDeadline: timestamp("freshness_deadline", { withTimezone: true }),
  sourcePublishedAt: timestamp("source_published_at", { withTimezone: true }),
  lastPublicationAt: timestamp("last_publication_at", { withTimezone: true }),
  publicationRevision: bigint("publication_revision", { mode: "number" }).notNull().default(0),
  lastOutcome: text("last_outcome"),
  freshnessWindowSec: integer("freshness_window_sec").notNull(),
  lastRowCount: integer("last_row_count"),
  activeEventCount: integer("active_event_count"),
  lastInserted: integer("last_inserted"),
  lastUpdated: integer("last_updated"),
  lastDeleted: integer("last_deleted"),
  lastRejected: integer("last_rejected"),
  lastDurationMs: integer("last_duration_ms"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  /** When the raw archive, over its cap, last evicted payloads from this source's hot window. */
  rawHotEvictedAt: timestamp("raw_hot_evicted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A shrink of a source that its complete polls state and that has not yet
 * taken effect: a poll stating far fewer of what the source had in effect
 * (`series`: fewer than half its polled change-only series; `records`: a
 * record count at or under the shrink tripwire) is more likely an empty or
 * cut-off answer than a real loss, so it ends nothing. The shrink takes
 * effect once consecutive complete polls have kept stating it for long
 * enough; a complete poll that does not shrink, or a publication, clears it.
 * Kept in the database, so a restart does not forget it, and written by the
 * one process that polls the source.
 */
export const sourceShrink = conditionsSchema.table(
  "source_shrink",
  {
    sourceId: text("source_id").notNull(),
    scope: text("scope").notNull(),
    /** The first poll of the run that stated the shrink. */
    since: timestamp("since", { withTimezone: true }).notNull(),
    /** Consecutive complete polls that stated it. */
    polls: integer("polls").notNull(),
    /** What the latest of them stated, of what was in effect. */
    stated: integer("stated").notNull(),
    held: integer("held").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.scope] }),
    check("source_shrink_scope_enum", sql`${t.scope} IN ('series','records')`),
  ],
);

/** Bounded operational audit trail. A separate scheduled task prunes old rows;
 * source_status remains the current authority used by routing. */
export const sourcePollAttempt = conditionsSchema.table(
  "source_poll_attempt",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    source: text("source").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    /** Null while the poll is still running: its id is the fetch id its raw payloads are filed under. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome").notNull(),
    networkValidated: boolean("network_validated").notNull(),
    published: boolean("published").notNull().default(false),
    activeEventCount: integer("active_event_count"),
    inserted: integer("inserted"),
    updated: integer("updated"),
    deleted: integer("deleted"),
    rejected: integer("rejected"),
    durationMs: integer("duration_ms"),
    partitionsSucceeded: integer("partitions_succeeded"),
    partitionsFailed: integer("partitions_failed"),
    partitionsTotal: integer("partitions_total"),
    error: text("error"),
    /** sha256 of each decoded response this attempt received, in fetch order: the identity a raw-payload archive files each response under. */
    payloadHashes: text("payload_hashes").array(),
  },
  (t) => [
    index("idx_source_poll_attempt_source_time").on(t.source, t.attemptedAt),
    index("idx_source_poll_attempt_time").on(t.attemptedAt, t.id),
  ],
);

/**
 * Derived / native / osm free-flow baselines of measurement sites, by the
 * subject key of the site's `traffic.speed` series (`feature:<featureId>`),
 * upserted. `dow_bucket`: 0 = weekday (Mon–Fri), 1 = weekend, -1 = per-site
 * overall. `tod_bucket`: 0–23 hour, -1 = overall. `method`: 'native' |
 * 'derived' | 'osm_maxspeed'.
 */
export const sensorBaseline = conditionsSchema.table(
  "sensor_baseline",
  {
    subjectKey: text("subject_key").notNull(),
    source: text("source").notNull(),
    dowBucket: smallint("dow_bucket").notNull(),
    todBucket: smallint("tod_bucket").notNull(),
    freeFlowKph: doublePrecision("free_flow_kph").notNull(),
    method: text("method").notNull(),
    contributorReceiptIds: text("contributor_receipt_ids").array(),
    lineageComplete: boolean("lineage_complete").notNull().default(false),
    permissionLicenses: text("permission_licenses").array(),
    contributing: text("contributing").array(),
    sampleCount: integer("sample_count").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectKey, t.dowBucket, t.todBucket, t.method] }),
    index("idx_sensor_baseline_source_bucket").on(t.source, t.dowBucket, t.todBucket),
  ],
);

/**
 * Imported OSM highway ways for the sensored regions (weekly refresh). Raw
 * geometry source for the directed segment spine below.
 */
export const osmRoad = conditionsSchema.table(
  "osm_road",
  {
    wayId: bigint("way_id", { mode: "number" }).primaryKey(),
    geom: geometry("geom").notNull(),
    highway: text("highway").notNull(),
    oneway: boolean("oneway").notNull().default(false),
    onewayReversed: boolean("oneway_reversed").notNull().default(false),
    ref: text("ref"),
    name: text("name"),
    maxspeedKph: doublePrecision("maxspeed_kph"),
    region: text("region").notNull(),
    importConfigHash: text("import_config_hash"),
    importProvenance: jsonb("import_provenance"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_osm_road_geom").using("gist", t.geom),
    index("idx_osm_road_highway").on(t.highway),
    index("idx_osm_road_ref").on(t.ref),
  ],
);

/**
 * The directed traffic-segment spine (v1: one row per way per travel
 * direction). `segmentId` = "${wayId}:${dir}", dir in {"f","b"}.
 */
export const roadSegment = conditionsSchema.table(
  "road_segment",
  {
    segmentId: text("segment_id").primaryKey(),
    wayId: bigint("way_id", { mode: "number" }).notNull(),
    dir: text("dir").notNull(),
    geom: geometry("geom").notNull(),
    highway: text("highway").notNull(),
    ref: text("ref"),
    lengthM: doublePrecision("length_m").notNull(),
    minZoom: smallint("min_zoom").notNull(),
    freeFlowKph: doublePrecision("free_flow_kph"),
    openlr: text("openlr"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_road_segment_geom").using("gist", t.geom),
    index("idx_road_segment_way").on(t.wayId),
    index("idx_road_segment_minzoom").on(t.minZoom),
  ],
);

/**
 * A measurement site -> segment binding (KNN snap), by the subject key of the
 * site's `traffic.speed` series.
 */
export const sensorSegment = conditionsSchema.table(
  "sensor_segment",
  {
    subjectKey: text("subject_key").primaryKey(),
    segmentId: text("segment_id").notNull(),
    fraction: doublePrecision("fraction").notNull(),
    offsetM: doublePrecision("offset_m").notNull(),
    bearingDeg: doublePrecision("bearing_deg"),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("idx_sensor_segment_segment").on(t.segmentId)],
);

/** Singleton identity and provenance of the segment spine currently active. */
export const roadGraphState = conditionsSchema.table(
  "road_graph_state",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    generation: text("generation").notNull(),
    status: text("status").notNull().default("ready"),
    regions: jsonb("regions").notNull(),
    highwayClasses: jsonb("highway_classes").notNull(),
    pbfProvenance: jsonb("pbf_provenance").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("road_graph_state_singleton", sql`${t.singleton} IS TRUE`)],
);

/** Current reviewed public licence policy, refreshed atomically with the source catalogue. */
export const publicLicensePolicy = conditionsSchema.table("public_license_policy", {
  license: text("license").primaryKey(),
});

/**
 * The multi-source/crowd/federation fusion seam: one row per (segment,
 * source), each source free to report on its own tier and cadence. A
 * `sensor` source is the freshest flow reading bound via `sensor_segment`;
 * later a crowd aggregate, a federation peer, or an authoritative feed can
 * land its own row here with its own tier. The fusion step (09) reduces all
 * rows per segment -> segment_speed.
 */
export const segmentObservation = conditionsSchema.table(
  "segment_observation",
  {
    segmentId: text("segment_id").notNull(),
    source: text("source").notNull(),
    sourceTier: text("source_tier").notNull(),
    currentKph: doublePrecision("current_kph"),
    freeFlowKph: doublePrecision("free_flow_kph"),
    speedRatio: doublePrecision("speed_ratio"),
    los: text("los").notNull(),
    /** How far the source trusts its own reading, 0 to 1. */
    confidenceScore: doublePrecision("confidence_score").notNull(),
    sampleCount: integer("sample_count"),
    /** Selected native identities and captured display receipts; rights stay in contributing. */
    nativeFieldSources: jsonb("native_field_sources"),
    fieldSources: jsonb("field_sources"),
    fieldContributors: jsonb("field_contributors"),
    fieldLineageComplete: jsonb("field_lineage_complete"),
    /** Exact captured permission IDs; null means missing evidence and is never public. */
    permissionLicenses: text("permission_licenses").array(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.source] }),
    check("segment_observation_los_check", sql.raw(enumCheckSql("los", SEGMENT_LOS))),
  ],
);

/**
 * Weekly per-(segment, weekday, hour) typical-speed profiles, derived from
 * the hourly `traffic.speed` rollups and bucketed in the segment's REGION-LOCAL
 * time (Valhalla convention: `dow` 0=Sun…6=Sat, `tod_hour` 0-23). Exported
 * to bake Valhalla's predicted-traffic tiles (see plan 12).
 */
export const segmentProfile = conditionsSchema.table(
  "segment_profile",
  {
    segmentId: text("segment_id").notNull(),
    dow: smallint("dow").notNull(),
    todHour: smallint("tod_hour").notNull(),
    speedKph: doublePrecision("speed_kph").notNull(),
    sampleCount: integer("sample_count").notNull(),
    contributorReceiptIds: text("contributor_receipt_ids").array(),
    lineageComplete: boolean("lineage_complete").notNull().default(false),
    permissionLicenses: text("permission_licenses").array(),
    /** The sources whose readings built this bucket's median. */
    contributing: text("contributing").array().notNull().default(sql`'{}'::text[]`),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.segmentId, t.dow, t.todHour] })],
);

/**
 * The fused + propagated live surface (one row per segment; the
 * render/routing read model). Populated by reducing `segment_observation`
 * rows per segment, then propagating one hop into adjacent gap segments
 * along the same ref/highway.
 */
export const segmentSpeed = conditionsSchema.table(
  "segment_speed",
  {
    segmentId: text("segment_id").primaryKey(),
    currentKph: doublePrecision("current_kph"),
    freeFlowKph: doublePrecision("free_flow_kph"),
    speedRatio: doublePrecision("speed_ratio"),
    los: text("los").notNull(),
    confidence: text("confidence").notNull(),
    sourceTier: text("source_tier"),
    contributing: text("contributing").array(),
    isEstimated: boolean("is_estimated").notNull().default(false),
    /** Selected native identities and captured display receipts; rights stay in contributing. */
    nativeFieldSources: jsonb("native_field_sources"),
    fieldSources: jsonb("field_sources"),
    fieldContributors: jsonb("field_contributors"),
    fieldLineageComplete: jsonb("field_lineage_complete"),
    /** Exact captured permission IDs; null means missing evidence and is never public. */
    permissionLicenses: text("permission_licenses").array(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  () => [
    check("segment_speed_los_check", sql.raw(enumCheckSql("los", SEGMENT_LOS))),
    check(
      "segment_speed_confidence_check",
      sql.raw(enumCheckSql("confidence", SEGMENT_SPEED_CONFIDENCES)),
    ),
  ],
);

/**
 * One row per pseudonymous crowd reporter, keyed by the RFC 7638 thumbprint of
 * its P-256 public key. Carries the Beta reliability posterior
 * (`reputation_alpha`/`reputation_beta`) trained only by externally resolved
 * outcomes, participation counters, and the entitlement window that gates
 * whether the key may still submit. Enrollment refreshes `last_active_at` and
 * `entitlement_expires_at`; the records sweep deletes a reporter once both are
 * more than twelve months old, and the delete takes the reporter's votes,
 * refusals and token quotas with it and clears it from the evidence ledger.
 */
export const reporter = conditionsSchema.table(
  "reporter",
  {
    keyId: text("key_id").primaryKey(),
    pubJwk: jsonb("pub_jwk").notNull(),
    reputationAlpha: doublePrecision("reputation_alpha").notNull(),
    reputationBeta: doublePrecision("reputation_beta").notNull(),
    corroboratedCount: integer("corroborated_count").notNull().default(0),
    trustSignal: doublePrecision("trust_signal"),
    entitlementExpiresAt: timestamp("entitlement_expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("reporter_last_active_at_idx").on(t.lastActiveAt),
    check("reporter_reputation_alpha_positive", sql`${t.reputationAlpha} > 0`),
    check("reporter_reputation_beta_positive", sql`${t.reputationBeta} > 0`),
    check("reporter_status_enum", sql`${t.status} IN ('active','blocked')`),
  ],
);

/**
 * Per-(key, epoch) count of anti-abuse tokens already issued — the rate-limit
 * ledger for a reporter's submission entitlement. The records sweep deletes a
 * row once its epoch (a UTC day) has ended.
 */
export const tokenQuota = conditionsSchema.table(
  "token_quota",
  {
    keyId: text("key_id").notNull(),
    epoch: text("epoch").notNull(),
    issued: integer("issued").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.keyId, t.epoch] }),
    foreignKey({
      name: "token_quota_key_id_fkey",
      columns: [t.keyId],
      foreignColumns: [reporter.keyId],
    }).onDelete("cascade"),
  ],
);

/**
 * Durable single-use ledger for redeemed anti-abuse tokens: one row per spent
 * token, keyed by the SHA-256 hex of the full serialized token bytes (each
 * token carries a random 32-byte nonce, so the hash is unique per token).
 * Redemption INSERTs here FIRST and treats a primary-key violation as
 * already-spent — fail closed. `purpose` records the domain-separated public
 * context the token was redeemed under. `expires_at` is the token's own
 * expiry, the end of its issuer key's validity: no token redeems after it, so
 * the records sweep deletes the row then.
 */
export const spentToken = conditionsSchema.table(
  "spent_token",
  {
    tokenHash: text("token_hash").primaryKey(),
    purpose: text("purpose").notNull(),
    spentAt: timestamp("spent_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("spent_token_expires_at_idx").on(t.expiresAt)],
);

/**
 * Operator-controlled block list: one row per reporter key an accountable
 * reviewer has blocked. Blocking is a post-hoc moderation action — it both
 * records the decision here (with the reviewer identity and reason for audit)
 * and flips the reporter row's status to `blocked`, so the attester zeroes the
 * key's grants and the report/vote paths refuse it. Block lists are NEVER
 * auto-synced across federation; each instance owns its own.
 */
export const blockList = conditionsSchema.table("block_list", {
  keyId: text("key_id").primaryKey(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  createdBy: text("created_by").notNull(),
});

/**
 * The append-only federation outbox journal — the single ordering authority
 * for what this instance federates. Row-level triggers on the situation,
 * feature and offer tables and on `observation_latest` (custom migration
 * `record_outbox_capture`; drizzle-kit cannot model triggers) append one entry
 * per change of one of this instance's own records IN THE CHANGE'S OWN
 * TRANSACTION, so a rollback appends nothing and a committed change is
 * journalled atomically. The columns say what an entry is without reading it
 * (class, id, kind, domain, property, priority); `snapshot` is the stored
 * record with its evidence summary, the reporter stripped at read. A
 * tombstone appends a `delete` entry with its reason, the revision the record
 * ended at (`revision`, so a subscriber orders it against the record's
 * changes), and no snapshot. A
 * successful poll of a public source appends a `liveness` entry (class
 * `observation`, the source's id as `record_id`, `{ sourceId, polledAt }` as
 * snapshot), at most one per source per ten minutes and only while a
 * subscription asks for them, so a peer keeps the source's unchanged readings
 * current (`journalSourceLiveness`). `seq`
 * (an identity column) is the strictly monotonic peer cursor; entries are never
 * updated by the application, except that an erasure scrubs the earlier
 * snapshots of the erased record.
 *
 * `txid` (the row's creating transaction id, `pg_current_xact_id()` captured
 * by the column DEFAULT) is the HIGH-ORDER half of the gap-free peer cursor.
 * `seq` advances per row but `txid` is assigned at a transaction's first write,
 * so an earlier-txid multi-row swap can interleave HIGHER seqs than a
 * later-txid concurrent writer — a bare `seq` cursor would skip the later
 * writer's lower seqs. {@link readOutbox} pages by the composite `(txid, seq)`
 * (ordering in transaction order) under an xmin fence, which is skip-free under
 * arbitrary interleaving; the covering index below serves that WHERE/ORDER BY.
 */
export const federationOutbox = conditionsSchema.table(
  "federation_outbox",
  {
    // By default, not always: a new journal epoch copies carried entries
    // back with the seq they had.
    seq: bigint("seq", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    operation: text("operation").notNull(),
    recordClass: text("record_class").notNull(),
    recordId: text("record_id").notNull(),
    canonicalId: text("canonical_id"),
    kind: text("kind").notNull(),
    domain: text("domain").notNull(),
    property: text("property"),
    priority: boolean("priority").notNull().default(false),
    snapshot: jsonb("snapshot"),
    tombstoneReason: text("tombstone_reason"),
    revision: integer("revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    txid: xid8("txid").notNull().default(sql`pg_current_xact_id()`),
  },
  (t) => [
    index("idx_federation_outbox_record").on(t.recordClass, t.recordId, t.seq),
    // The composite peer cursor's covering index: WHERE/ORDER BY are (txid, seq).
    index("idx_federation_outbox_cursor").on(t.txid, t.seq),
    // The daily retention prune deletes on `created_at < floor`; this btree
    // keeps that a range scan instead of a full seq-scan as the journal grows.
    index("idx_federation_outbox_created_at").on(t.createdAt),
    check(
      "federation_outbox_operation_enum",
      sql`${t.operation} IN ('create','update','delete','liveness')`,
    ),
    check(
      "federation_outbox_record_class_enum",
      sql.raw(enumCheckSql("record_class", RECORD_CLASSES)),
    ),
    // A change carries its record, a delete its reason and nothing else.
    check(
      "federation_outbox_delete_shape",
      sql`(${t.operation} = 'delete') = (${t.snapshot} IS NULL AND ${t.tombstoneReason} IS NOT NULL)`,
    ),
  ],
);

/**
 * Which history the journal's entries belong to: at most one row. `txid` is a
 * raw transaction id, so a cursor only means something within one database
 * history. `epoch` names the current one; the federation service starts a new
 * epoch at boot (emptying the journal and resetting the push cursors) when
 * the row is missing (the operator's request after rolling the database
 * back), when the database is another one than it was (a dump restored into
 * a new database, a database re-created from a template, a move to another
 * cluster), when transaction ids went back (a logical restore) or when the
 * Postgres timeline changed (point-in-time recovery, promotion). `seen_xid`
 * is the highest transaction id the service has seen the database at;
 * `timeline_id` the timeline it last ran on, `database_oid` the database's
 * OID and `system_identifier` the cluster's, each null while it could not be
 * read. Every page states the epoch, so a subscriber knows its cursor is void.
 */
export const federationJournal = conditionsSchema.table(
  "federation_journal",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    epoch: uuid("epoch").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    seenXid: xid8("seen_xid").notNull(),
    timelineId: integer("timeline_id"),
    databaseOid: bigint("database_oid", { mode: "number" }),
    systemIdentifier: bigint("system_identifier", { mode: "bigint" }),
  },
  (t) => [check("federation_journal_single_row", sql`${t.singleton}`)],
);

/**
 * The erasure fact, keyed by `canonical_id` and the instance that erased it.
 * When a record is erased (tombstoned `rights_revoked`, here or by the peer
 * that owns it) its canonical id is recorded so no later delivery of the same
 * record is admitted while the fact is live. This also closes the
 * erasure-before-delivery race: an erasure that arrives before the record
 * still records the fact. A peer's erasure (`peer_instance_id` that peer)
 * refuses only that peer's deliveries, so no peer can block another's
 * records; this instance's own (`peer_instance_id` empty) refuses every
 * peer's. `expires_at` is the 30-day retention of the deletion fact, and the
 * records sweep deletes the row once it passes. The ROW is the deletion fact —
 * never the erased content.
 */
export const federationTombstone = conditionsSchema.table(
  "federation_tombstone",
  {
    canonicalId: text("canonical_id").notNull(),
    peerInstanceId: text("peer_instance_id").notNull().default(""),
    reason: text("reason").notNull(),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.canonicalId, t.peerInstanceId] }),
    index("federation_tombstone_expires_at_idx").on(t.expiresAt),
    check("federation_tombstone_reason_check", sql.raw(enumCheckSql("reason", TOMBSTONE_REASONS))),
  ],
);

/**
 * When this instance last received each source from each peer: any record
 * of the source a delivery from that peer carried, landed or no newer than
 * the stored copy, or the peer's liveness entry of the source (when the peer
 * polled it, never later than its delivery). A peer sends a polled
 * change-only reading only when it changes, and states no `validUntil` for
 * it; the reading holds while its source keeps arriving from that peer
 * (`withPolledValidity`). Kept apart
 * from `source_status`, which is this instance's own polling.
 */
export const federationSourceReceipt = conditionsSchema.table(
  "federation_source_receipt",
  {
    peerInstanceId: text("peer_instance_id").notNull(),
    sourceId: text("source_id").notNull(),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }).notNull(),
    /**
     * When the peer last said it polled the source (a liveness entry); null
     * for a peer that never did. Only such a peer's copies of the source end
     * once it falls silent (`federation_lapsed_copy`).
     */
    livenessAt: timestamp("liveness_at", { withTimezone: true }),
    /**
     * How often the peer said it polls the source, in seconds; null until it
     * said. A reading of the source holds, and a copy stays, as long as the
     * peer's polling keeps them current, not this instance's own of the
     * source, which it may poll less often or not at all.
     */
    cadenceSec: integer("cadence_sec"),
  },
  (t) => [primaryKey({ columns: [t.peerInstanceId, t.sourceId] })],
);

/**
 * A peer's copy the sweep ended because the peer fell silent about its
 * source: the peer sends liveness, yet nothing of the source arrived from it
 * for the lapse window. The copy kept the peer's revision; when the peer's
 * liveness of the source arrives again, a copy still at that revision and
 * ended so is live again (a quiet record is never re-sent). A copy the peer
 * changed or retracted since is no longer this row's to restore.
 */
export const federationLapsedCopy = conditionsSchema.table(
  "federation_lapsed_copy",
  {
    recordClass: text("record_class").notNull(),
    recordId: text("record_id").notNull(),
    peerInstanceId: text("peer_instance_id").notNull(),
    sourceId: text("source_id").notNull(),
    revision: integer("revision").notNull(),
    lapsedAt: timestamp("lapsed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recordClass, t.recordId] }),
    index("idx_federation_lapsed_copy_source").on(t.peerInstanceId, t.sourceId),
  ],
);

/**
 * The erasures the kept nightly archive files are already free of, each
 * `id:<record id>` or `canonical:<canonical id>`, so a night rescans the files
 * only for an erasure it has not applied. Kept in the database, not beside the
 * files, because the archive directory is served as it is.
 */
export const archiveErasure = conditionsSchema.table("archive_erasure", {
  key: text("key").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The latest nightly archive, one file per record class, as a peer fetches
 * it: the dated file's name under the archive's URL, its SHA-256 (hex) and
 * size, and when the night's build began. A peer catching up from beyond its
 * live window is served these in a signed page and checks each file it
 * fetches against them. Kept in the database, not beside the files, because
 * the archive directory is served as it is.
 */
export const archiveFile = conditionsSchema.table("archive_file", {
  recordClass: text("record_class").primaryKey(),
  fileName: text("file_name").notNull(),
  sha256: text("sha256").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull(),
});

/**
 * The cells of on-demand sources this instance has fetched: a `fresh` cell
 * is not fetched again before `expires_at`, a `failed` one not before
 * `retry_at`. A cell is the id of a fixed grid square of the source's cell
 * size, so reads of overlapping boxes share it. A reader fetching a cell
 * claims it until `claimed_until`, so no other reader, in any process,
 * fetches it meanwhile; a claim its claimant never cleared lapses then.
 */
export const onDemandFetch = conditionsSchema.table(
  "on_demand_fetch",
  {
    sourceId: text("source_id").notNull(),
    cell: text("cell").notNull(),
    /** When the cell was last answered; null until its first answer. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** `pending` until the cell's first fetch ends, then `fresh` or `failed`. */
    status: text("status").notNull(),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.cell] }),
    check("on_demand_fetch_status_enum", sql`${t.status} IN ('pending','fresh','failed')`),
  ],
);

/**
 * The request budget of each on-demand source, kept in the database so a
 * restart does not reset it: a per-minute token bucket (`tokens`, last
 * refilled at `refilled_at`) and the requests made on the UTC day `day`.
 */
export const onDemandQuota = conditionsSchema.table("on_demand_quota", {
  sourceId: text("source_id").primaryKey(),
  tokens: real("tokens").notNull(),
  refilledAt: timestamp("refilled_at", { withTimezone: true }).notNull(),
  day: date("day").notNull(),
  dayCount: integer("day_count").notNull(),
});

/**
 * One row: a fixed text sealed with the instance's secrets key, which the
 * ingest service writes once. Every other service that holds the key opens
 * it at start and refuses to start when it does not open, so a service given
 * another key than the ingest service's never seals anything with it.
 */
export const secretsKeyCheck = conditionsSchema.table(
  "secrets_key_check",
  {
    id: smallint("id").primaryKey().default(1),
    valueCiphertext: bytea("value_ciphertext").notNull(),
    valueIv: bytea("value_iv").notNull(),
    valueTag: bytea("value_tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("secrets_key_check_id_check", sql`${t.id} = 1`),
    check("secrets_key_check_value_check", sealedSecretCheck("value")),
  ],
);

/**
 * This instance's rotating token-issuer keypairs, each valid across a
 * [not_before, not_after) window. The private key (PKCS#8) is stored sealed
 * with the instance's secrets key (AES-256-GCM, bound to the key id).
 */
export const issuerKey = conditionsSchema.table(
  "issuer_key",
  {
    keyId: text("key_id").primaryKey(),
    publicKey: bytea("public_key").notNull(),
    privateKeyCiphertext: bytea("private_key_ciphertext").notNull(),
    privateKeyIv: bytea("private_key_iv").notNull(),
    privateKeyTag: bytea("private_key_tag").notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
  },
  () => [check("issuer_key_private_key_check", sealedSecretCheck("private_key"))],
);

/**
 * This instance's rotating federation Ed25519 signing keys. `key_id` and
 * `multibase` are both the key's publicKeyMultibase ("z6Mk…" — served in the
 * Actor document and exchanged out-of-band as the bilateral pin fingerprint);
 * `public_key` is the raw 32-byte Ed25519 key and `private_key` its PKCS#8
 * form — an operator secret that is never served, logged, or federated, and
 * stored sealed with the instance's secrets key (AES-256-GCM, bound to the
 * key id).
 * Rotation keeps the old and new key's [not_before, not_after) windows
 * overlapping (≥30 days) so peers keep verifying while the new key propagates.
 * Every key but the first is endorsed by the key before it: `endorsed_by` is
 * that key's id, and `endorsement` its and `endorsement_proof` the new key's
 * Ed25519 signature that the new key is this instance's next, which a peer
 * that trusts the old key checks before it trusts the new.
 */
export const federationInstanceKey = conditionsSchema.table(
  "federation_instance_key",
  {
    keyId: text("key_id").primaryKey(),
    publicKey: bytea("public_key").notNull(),
    privateKeyCiphertext: bytea("private_key_ciphertext").notNull(),
    privateKeyIv: bytea("private_key_iv").notNull(),
    privateKeyTag: bytea("private_key_tag").notNull(),
    multibase: text("multibase").notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    endorsedBy: text("endorsed_by"),
    endorsement: bytea("endorsement"),
    endorsementProof: bytea("endorsement_proof"),
  },
  () => [check("federation_instance_key_private_key_check", sealedSecretCheck("private_key"))],
);

/**
 * The keys of a pinned peer this instance trusts beyond its configured pins:
 * the keys its actor document served, endorsed by a key already trusted,
 * when this instance last verified that document. Replaced at each
 * verification, so a key the peer retired is trusted no longer. `anchor` is
 * the configured pin the key's endorsements lead back to: a key is trusted
 * only while that pin is configured.
 */
export const federationPeerKey = conditionsSchema.table(
  "federation_peer_key",
  {
    peerInstanceId: text("peer_instance_id").notNull(),
    keyId: text("key_id").notNull(),
    anchor: text("anchor").notNull(),
    learnedAt: timestamp("learned_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.peerInstanceId, t.keyId] })],
);

/**
 * Per-peer OPERATIONS (health) counters — a TRANSPORT-plane signal only. It
 * tracks how well a pinned peer behaves as a federation participant
 * (availability, and the rate of signature/replay/schema/rate-limit failures)
 * so an operator, the rate policy, or a reviewer notification can react.
 *
 * BINDING (ADR §8): PEER HEALTH IS SEPARATE FROM EVENT TRUTH. Nothing here ever
 * feeds evidence_state, confidence_score, routing eligibility, or reporter
 * reputation. A low-scoring peer's already-received events are never re-judged;
 * only transport controls (rate, block) may apply. `effective_tier_until` is a
 * transport-only cooldown marker for a temporary rate-tier downgrade — it does
 * not change how the peer's events are trusted.
 */
export const federationPeerHealth = conditionsSchema.table("federation_peer_health", {
  peerId: text("peer_id").primaryKey(),
  availabilityOk: integer("availability_ok").notNull().default(0),
  availabilityFail: integer("availability_fail").notNull().default(0),
  signatureFailures: integer("signature_failures").notNull().default(0),
  replayFailures: integer("replay_failures").notNull().default(0),
  schemaFailures: integer("schema_failures").notNull().default(0),
  rateViolations: integer("rate_violations").notNull().default(0),
  effectiveTierUntil: timestamp("effective_tier_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The schema versions a pinned peer advertises (`<key>@<major>.<minor>`, as
 * its actor document lists them), refreshed whenever this instance fetches
 * and verifies that document. Admitting the peer's records reads them: a
 * record of a schema the two do not share at one major is skipped.
 */
export const federationPeerCapabilities = conditionsSchema.table("federation_peer_capabilities", {
  peerInstanceId: text("peer_instance_id").primaryKey(),
  schemaVersions: text("schema_versions").array().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  /**
   * The protocol version the two negotiated from that document, which says
   * which routes the peer serves; null when not recorded.
   */
  protocolVersion: text("protocol_version"),
});

/**
 * How far this instance has read each peer's journal by pull: the composite
 * `(txid, seq)` cursor (wire form) of the last page it landed, advanced only
 * once that page's entries were landed, so a failed page is read again. Only
 * a peer whose record asks for pulling has a row.
 */
export const federationPeerCursor = conditionsSchema.table("federation_peer_cursor", {
  peerInstanceId: text("peer_instance_id").primaryKey(),
  cursor: text("cursor").notNull().default("0.0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  /**
   * The night of the peer's archive last landed whole, and when: an archive
   * no newer is not landed again, nor any within a day of the last, however
   * often the peer's pages name one.
   */
  archiveBuiltAt: timestamp("archive_built_at", { withTimezone: true }),
  archiveLandedAt: timestamp("archive_landed_at", { withTimezone: true }),
  /**
   * The epoch of the peer's journal the cursor belongs to (opaque: whatever
   * string the peer's pages name), and when the cursor was last reset because
   * the peer's journal started over (a new epoch, or a cursor ahead of it). A
   * second reset within the hour is refused rather than followed.
   */
  journalEpoch: text("journal_epoch"),
  cursorResetAt: timestamp("cursor_reset_at", { withTimezone: true }),
  /**
   * Since when this instance's copies of the peer's records are to be
   * compared with the peer's present state (null: no comparison is due): set
   * when the peer's journal started over and when a page said the cursor was
   * beyond the peer's window, as neither the journal nor the archive then says
   * what the peer ended meanwhile. How far the running comparison got (the
   * class and the last record id compared; null: not begun), and when the
   * last one finished.
   */
  reconcileDueSince: timestamp("reconcile_due_since", { withTimezone: true }),
  reconcileClass: text("reconcile_class"),
  reconcileAfter: text("reconcile_after"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
});

/**
 * Operator-controlled federation block list: one row per peer this operator has
 * blocked. A blocked peer's inbox/backfill/outbox/subscribe requests are
 * refused with 403. Blocking is a PER-OPERATOR transport decision — it is NEVER
 * auto-synced or propagated across the federation (a Tier-2 RECOMMENDED list an
 * operator may voluntarily adopt is a separate opt-in, not enforced here). Like
 * the reporter block list, blocking a peer is a transport control, never a
 * judgement that the peer's already-received events are false.
 */
export const federationBlocklist = conditionsSchema.table("federation_blocklist", {
  peerId: text("peer_id").primaryKey(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
});

/**
 * A peer's federation subscription: the relationship a subscribing instance
 * establishes so it receives this instance's outbox, plus HOW it wants that
 * delivery. `delivery_mode` layers push (webhook/sse) as a LATENCY optimization
 * over the proven pull contract. `cursor` is the PUSH-CHANNEL cursor: under
 * `priority_only` the push channel carries ONLY the priority classes and this
 * cursor advances ONLY over those priority events (the scan is priority-restricted
 * at SQL), so it can never be advanced past a non-priority but matching event.
 * COMPLETENESS is the peer's OWN independent pull of `/peer/outbox` (never
 * `priority_only`-restricted); push is a latency optimization for priority events,
 * not the completeness channel. A successful push advances `cursor` to the
 * delivered priority page's frontier; a dropped push does NOT advance it, so the
 * same priority events re-push idempotently and the peer's pull covers everything.
 *
 * `push_failures` counts CONSECUTIVE delivery failures; once it reaches the
 * threshold the row flips to `push_disabled` and the publisher stops pushing —
 * the peer keeps every event via pull. A recovered peer re-enables push with a
 * PATCH (which resets the counter and status).
 *
 * `expires_at` is the subscription's lease: every accepted PATCH renews it,
 * and a subscription not renewed in time stops acting, is no longer shown to
 * its peer and is deleted, so a peer that disappeared stops having this
 * instance journal for it. The default only fills rows written before the
 * lease existed; the code always writes it.
 */
export const federationSubscription = conditionsSchema.table(
  "federation_subscription",
  {
    id: text("id").primaryKey(),
    peerId: text("peer_id").notNull(),
    filter: jsonb("filter").notNull().default({}),
    deliveryMode: text("delivery_mode").notNull().default("pull"),
    inboxUrl: text("inbox_url"),
    cursor: text("cursor").notNull().default("0.0"),
    priorityOnly: boolean("priority_only").notNull().default(true),
    pushFailures: integer("push_failures").notNull().default(0),
    revision: integer("revision").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),
  },
  (t) => [
    index("idx_federation_subscription_peer").on(t.peerId),
    // A peer holds one pull subscription and one webhook per inbox, which it
    // patches to what it wants; a second would push or journal twice.
    uniqueIndex("uq_federation_subscription_target")
      .on(t.peerId, t.deliveryMode, sql`coalesce(${t.inboxUrl}, '')`)
      .where(sql`${t.deliveryMode} <> 'sse'`),
    check(
      "federation_subscription_delivery_mode_enum",
      sql`${t.deliveryMode} IN ('pull','webhook','sse')`,
    ),
    check("federation_subscription_status_check", sql`${t.status} IN ('active','push_disabled')`),
  ],
);

/** Durable latest provider revision, including explicit suppression with no public reading. */
export const observationRevision = conditionsSchema.table(
  "observation_revision",
  {
    sourceId: text("source_id").notNull(),
    featureId: text("feature_id").notNull(),
    property: text("property").notNull(),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
    rank: text("rank").notNull(),
    signature: text("signature").notNull(),
    suppressed: boolean("suppressed").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.featureId, t.property] })],
);

/** Last wholly accepted GeoNet acquisition; publication shares its transaction. */
export const geonetCoverage = conditionsSchema.table("geonet_coverage", {
  revisions: jsonb("revisions").notNull().default({}),
  sourceId: text("source_id").primaryKey(),
  coveredFrom: timestamp("covered_from", { withTimezone: true }).notNull(),
  coveredUntil: timestamp("covered_until", { withTimezone: true }).notNull(),
});

/** Durable CAP message window for SMN's rolling indexes, committed with publication. */
export const smnCapMessage = conditionsSchema.table(
  "smn_cap_message",
  {
    sourceId: text("source_id").notNull(),
    identifier: text("identifier").notNull(),
    variant: text("variant").generatedAlwaysAs(sql`encode(sha256(body), 'hex')`).notNull(),
    retrieval: jsonb("retrieval").notNull(),
    body: bytea("body").notNull(),
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.variant] })],
);

/** The bounded latest SMN projection decision, committed with originals and public records. */
export const smnCapDecision = conditionsSchema.table("smn_cap_decision", {
  sourceId: text("source_id").primaryKey(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  decision: jsonb("decision").notNull(),
});

/** RFS publisher clocks survive record expiry and bounded revision retention.
 * No automatic pruning: forgetting an incident would permit its stale revival.
 * Empty incident id holds the distribution high-water, not absence authority.
 */
export const nswRfsClock = conditionsSchema.table(
  "nsw_rfs_clock",
  {
    sourceId: text("source_id").notNull(),
    incidentId: text("incident_id").notNull(),
    sent: text("sent").notNull(),
    published: text("published").notNull(),
    content: text("content").notNull(),
    expiry: text("expiry").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.incidentId] })],
);
