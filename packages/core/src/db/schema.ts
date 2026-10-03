import {
  EVIDENCE_STATES,
  enumCheckSql,
  FUZZINESS,
  PRIVACY_CLASSES,
  RECORD_CLASSES,
} from "@openconditions/model";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bytea, conditionsSchema, geometry, geometryPoint, xid8 } from "./columns.js";

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

/** Bounded operational audit trail. A separate scheduled task prunes old rows;
 * source_status remains the current authority used by routing. */
export const sourcePollAttempt = conditionsSchema.table(
  "source_poll_attempt",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
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
    confidence: doublePrecision("confidence").notNull(),
    sampleCount: integer("sample_count"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.source] }),
    index("idx_segment_observation_segment").on(t.segmentId),
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
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.dow, t.todHour] }),
    index("idx_segment_profile_segment").on(t.segmentId),
  ],
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
    observedAt: timestamp("observed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("idx_segment_speed_los").on(t.los)],
);

/**
 * One row per pseudonymous crowd reporter, keyed by the RFC 7638 thumbprint of
 * its P-256 public key. Carries the Beta reliability posterior
 * (`reputation_alpha`/`reputation_beta`) trained only by externally resolved
 * outcomes, participation counters, and the entitlement window that gates
 * whether the key may still submit.
 */
export const reporter = conditionsSchema.table(
  "reporter",
  {
    keyId: text("key_id").primaryKey(),
    pubJwk: jsonb("pub_jwk").notNull(),
    osmUid: text("osm_uid"),
    emailLookupHmac: text("email_lookup_hmac"),
    reputationAlpha: doublePrecision("reputation_alpha").notNull(),
    reputationBeta: doublePrecision("reputation_beta").notNull(),
    corroboratedCount: integer("corroborated_count").notNull().default(0),
    flaggedCount: integer("flagged_count").notNull().default(0),
    trustSignal: doublePrecision("trust_signal"),
    entitlementExpiresAt: timestamp("entitlement_expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("reporter_reputation_alpha_positive", sql`${t.reputationAlpha} > 0`),
    check("reporter_reputation_beta_positive", sql`${t.reputationBeta} > 0`),
    check("reporter_status_enum", sql`${t.status} IN ('active','blocked')`),
  ],
);

/**
 * Per-(key, epoch) count of anti-abuse tokens already issued — the rate-limit
 * ledger for a reporter's submission entitlement.
 */
export const tokenQuota = conditionsSchema.table(
  "token_quota",
  {
    keyId: text("key_id").notNull(),
    epoch: text("epoch").notNull(),
    issued: integer("issued").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.epoch] })],
);

/**
 * Durable single-use ledger for redeemed anti-abuse tokens: one row per spent
 * token, keyed by the SHA-256 hex of the full serialized token bytes (each
 * token carries a random 32-byte nonce, so the hash is unique per token).
 * Redemption INSERTs here FIRST and treats a primary-key violation as
 * already-spent — fail closed. `purpose` records the domain-separated public
 * context the token was redeemed under; `spent_at` feeds a later retention
 * sweep.
 */
export const spentToken = conditionsSchema.table(
  "spent_token",
  {
    tokenHash: text("token_hash").primaryKey(),
    purpose: text("purpose").notNull(),
    spentAt: timestamp("spent_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("idx_spent_token_spent_at").on(t.spentAt)],
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
 * tombstone appends a `delete` entry with its reason and no snapshot. `seq`
 * (bigserial) is the strictly monotonic peer cursor; entries are never
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
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
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
    check("federation_outbox_operation_enum", sql`${t.operation} IN ('create','update','delete')`),
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
 * The erasure fact, keyed by `canonical_id` and the instance that erased it.
 * When a record is erased (tombstoned `rights_revoked`, here or by the peer
 * that owns it) its canonical id is recorded so no later delivery of the same
 * record is admitted while the fact is live. This also closes the
 * erasure-before-delivery race: an erasure that arrives before the record
 * still records the fact. A peer's erasure (`peer_instance_id` that peer)
 * refuses only that peer's deliveries, so no peer can block another's
 * records; this instance's own (`peer_instance_id` empty) refuses every
 * peer's. `expires_at` is the 30-day retention of the deletion fact. The ROW
 * is the deletion fact — never the erased content.
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
  (t) => [primaryKey({ columns: [t.canonicalId, t.peerInstanceId] })],
);

/**
 * This instance's rotating token-issuer keypairs, each valid across a
 * [not_before, not_after) window.
 */
export const issuerKey = conditionsSchema.table("issuer_key", {
  keyId: text("key_id").primaryKey(),
  publicKey: bytea("public_key").notNull(),
  privateKey: bytea("private_key").notNull(),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
  notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
});

/**
 * This instance's rotating federation Ed25519 signing keys. `key_id` and
 * `multibase` are both the key's publicKeyMultibase ("z6Mk…" — served in the
 * Actor document and exchanged out-of-band as the bilateral pin fingerprint);
 * `public_key` is the raw 32-byte Ed25519 key and `private_key` its PKCS#8
 * form — an operator secret that is never served, logged, or federated.
 * Rotation keeps the old and new key's [not_before, not_after) windows
 * overlapping (≥30 days) so peers keep verifying while the new key propagates.
 */
export const federationInstanceKey = conditionsSchema.table("federation_instance_key", {
  keyId: text("key_id").primaryKey(),
  publicKey: bytea("public_key").notNull(),
  privateKey: bytea("private_key").notNull(),
  multibase: text("multibase").notNull(),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
  notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

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
  },
  (t) => [
    index("idx_federation_subscription_peer").on(t.peerId),
    check(
      "federation_subscription_delivery_mode_enum",
      sql`${t.deliveryMode} IN ('pull','webhook','sse')`,
    ),
  ],
);
