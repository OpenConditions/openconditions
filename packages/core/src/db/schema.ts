import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
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
  uniqueIndex,
} from "drizzle-orm/pg-core";

const conditionsSchema = pgSchema("conditions");

/** PostGIS geometry column. Requires the `postgis` extension (created by the
 * first migration, which drizzle-kit cannot model on its own). */
const geometry = customType<{ data: string }>({
  dataType() {
    return "geometry(Geometry, 4326)";
  },
});

/** PostGIS Point geometry column (crowd sub-claims are always single points). */
const geometryPoint = customType<{ data: string }>({
  dataType() {
    return "geometry(Point, 4326)";
  },
});

/** Raw bytes column (issuer signing keypair material). */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
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
    // Deterministic hash of the observation's meaningful fields (see
    // write-postgis.ts computeContentHash). Diff key for the swap upsert —
    // never queried directly, only compared inside `ON CONFLICT ... WHERE`.
    contentHash: text("content_hash"),

    // Commons substrate: identity/lineage, uncertainty, privacy and provenance
    // fields for crowd-reporting/federation. The ingest pipeline's
    // normalizeObservation seam stamps instance_id, canonical_id,
    // phenomenon_fingerprint, privacy_class and source_uri/source_license on
    // every feed row; the remaining fields await their consumers (crowd
    // reporting, probe aggregation, federation).
    instanceId: text("instance_id"),
    canonicalId: text("canonical_id"),
    phenomenonFingerprint: text("phenomenon_fingerprint"),
    replaces: jsonb("replaces"),
    corroborations: jsonb("corroborations"),
    fuzziness: text("fuzziness").notNull().default("exact"),
    confidenceScore: doublePrecision("confidence_score"),
    // Materialized outputs of the crowd evidence policy (evaluateEvidence). The
    // raw report_evidence ledger stays authoritative; these are derived and a
    // replay recomputes them, so they are excluded from content_hash. NULL on
    // non-crowd rows.
    evidenceState: text("evidence_state"),
    routingEligible: boolean("routing_eligible").notNull().default(false),
    // First-flag marker for the reviewer queue (set by the sub-claim flag route,
    // never at landing). A flag is not evidence of truth/falsehood, so it does
    // not touch the evidence ledger; it only lights up this timestamp. Excluded
    // from content_hash (never set on feed/crowd insert).
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
    severityLevel: smallint("severity_level"),
    privacyClass: text("privacy_class").notNull().default("unknown"),
    kAnonymity: integer("k_anonymity"),
    dpEpsilon: doublePrecision("dp_epsilon"),
    dpDelta: doublePrecision("dp_delta"),
    informed: jsonb("informed"),
    sourceUri: text("source_uri"),
    sourceLicense: text("source_license"),
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
    index("idx_conditions_obs_canonical").on(t.canonicalId),
    index("idx_conditions_obs_phenomenon").on(t.phenomenonFingerprint),
    index("idx_conditions_obs_instance").on(t.instanceId),
    index("idx_conditions_obs_privacy").on(t.privacyClass),
    index("idx_conditions_obs_evidence_state").on(t.evidenceState),
    index("idx_conditions_obs_flagged")
      .on(t.flaggedAt)
      .where(sql`${t.flaggedAt} IS NOT NULL`),
    check(
      "obs_confidence_score_range",
      sql`${t.confidenceScore} IS NULL OR (${t.confidenceScore} >= 0 AND ${t.confidenceScore} <= 1)`
    ),
    check("obs_dp_epsilon_nonneg", sql`${t.dpEpsilon} IS NULL OR ${t.dpEpsilon} >= 0`),
    check(
      "obs_dp_delta_range",
      sql`${t.dpDelta} IS NULL OR (${t.dpDelta} >= 0 AND ${t.dpDelta} < 1)`
    ),
    check("obs_k_anonymity_positive", sql`${t.kAnonymity} IS NULL OR ${t.kAnonymity} > 0`),
    check(
      "obs_severity_level_range",
      sql`${t.severityLevel} IS NULL OR (${t.severityLevel} >= 1 AND ${t.severityLevel} <= 5)`
    ),
    check(
      "obs_fuzziness_enum",
      sql`${t.fuzziness} IN ('exact','low_res','medium_res','end_unknown','start_unknown','extent_unknown')`
    ),
    check(
      "obs_privacy_class_enum",
      sql`${t.privacyClass} IN ('unknown','authoritative','aggregate','k_anon','dp_noised','crowd_pseudonym')`
    ),
    check(
      "obs_evidence_state_enum",
      sql`${t.evidenceState} IS NULL OR ${t.evidenceState} IN ('self_reported','corroborated','externally_resolved','negated','expired')`
    ),
  ]
);

/**
 * One row per feed source, updated on every poll cycle (including a 304/
 * unchanged no-op) so freshness and orphan-status can be derived from *when
 * the source last polled/succeeded* rather than from any individual row's
 * `fetched_at`. This is what lets a healthy feed sitting behind a 304 keep
 * its last-good rows indefinitely instead of aging out of `sweepStale
 * Observations` after `ORPHAN_MAX_AGE_SEC` — the swap only touches
 * `fetched_at` for rows that actually changed, so a per-row freshness check
 * would otherwise treat an unchanged-but-healthy source as gone stale.
 */
export const sourceStatus = conditionsSchema.table("source_status", {
  source: text("source").primaryKey(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  freshnessWindowSec: integer("freshness_window_sec").notNull(),
  lastRowCount: integer("last_row_count"),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_osm_road_geom").using("gist", t.geom),
    index("idx_osm_road_highway").on(t.highway),
    index("idx_osm_road_ref").on(t.ref),
  ]
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
  ]
);

/**
 * Sensor -> segment binding (KNN snap + carriageway disambiguation).
 * `sensorKey` matches Phase A's convention exactly (flow.id).
 */
export const sensorSegment = conditionsSchema.table(
  "sensor_segment",
  {
    sensorKey: text("sensor_key").primaryKey(),
    segmentId: text("segment_id").notNull(),
    fraction: doublePrecision("fraction").notNull(),
    offsetM: doublePrecision("offset_m").notNull(),
    bearingDeg: doublePrecision("bearing_deg"),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("idx_sensor_segment_segment").on(t.segmentId)]
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
  ]
);

/**
 * Weekly per-(segment, weekday, hour) typical-speed profiles, derived from
 * `sensor_speed_sample` history and bucketed in the segment's REGION-LOCAL
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
  ]
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
  (t) => [index("idx_segment_speed_los").on(t.los)]
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
  ]
);

/**
 * A signed reaction to an existing report/observation: a confirm, negate, or
 * flag from one reporter key. The unique index enforces one reaction per
 * (subject, key, type) so a key cannot stuff the ballot on a single subject.
 */
export const subClaim = conditionsSchema.table(
  "sub_claim",
  {
    id: text("id").primaryKey(),
    subjectId: text("subject_id").notNull(),
    claimType: text("claim_type").notNull(),
    keyId: text("key_id").notNull(),
    reason: text("reason"),
    geom: geometryPoint("geom"),
    signature: text("signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_sub_claim_subject_key_type").on(t.subjectId, t.keyId, t.claimType),
    index("idx_sub_claim_subject").on(t.subjectId),
    index("idx_sub_claim_key").on(t.keyId),
    check("sub_claim_claim_type_enum", sql`${t.claimType} IN ('confirm','negate','flag')`),
  ]
);

/**
 * The append-only, authoritative evidence ledger for a crowd observation: one
 * row per admissible piece of evidence (report/confirm/negate/external
 * resolution/expiry). The observation's derived evidence_state/routing_eligible
 * are a replayable projection of these rows (see evidenceRowsToLedger +
 * evaluateEvidence).
 */
export const reportEvidence = conditionsSchema.table(
  "report_evidence",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    observationId: text("observation_id").notNull(),
    evidenceKind: text("evidence_kind").notNull(),
    actorKeyId: text("actor_key_id"),
    sourceId: text("source_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("idx_report_evidence_observation").on(t.observationId, t.occurredAt),
    // Supports the per-key report-rate limiter's trailing-window count.
    index("idx_report_evidence_actor").on(t.actorKeyId, t.occurredAt),
    check(
      "report_evidence_kind_enum",
      sql`${t.evidenceKind} IN ('report','confirm','negate','official_match','reviewer_accept','reviewer_reject','expired')`
    ),
  ]
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
  (t) => [primaryKey({ columns: [t.keyId, t.epoch] })]
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
  (t) => [index("idx_spent_token_spent_at").on(t.spentAt)]
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
