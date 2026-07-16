/**
 * The reviewer anomaly queue: the observations carrying an OPEN flag
 * (`flagged_at IS NOT NULL` AND `status = 'active'`), newest flag first. A flag
 * is a marker, not evidence, so the queue reads the observation's `flagged_at`
 * plus the flag `sub_claim` rows that name it — never the evidence ledger.
 * Auto-flags (kinematic/StreetComplete) set `flagged_at` with no sub_claim, so
 * an item's `flagCount` can legitimately be 0 with an empty `flagReasons`.
 */
import type postgres from "postgres";
import { reliabilityLowerBound, type GeoJsonGeometry } from "@openconditions/core";

type Sql = postgres.Sql;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Fixed credible level for the advisory reliability lower bound. Shared with the
 * `/contrib/reporter/me` own-reputation read in server.ts — there is exactly ONE
 * advisory credible level for this number across the service.
 */
export const ADVISORY_CREDIBLE_LEVEL = 0.9;

/**
 * Advisory disclaimer stamped onto every surfaced reputation signal. Mirrors the
 * `/contrib/reporter/me` note so a reviewer never over-reads the number: it is
 * triage context, NOT a probability the observation is true.
 */
export const ADVISORY_REPUTATION_NOTE =
  "advisory — not a probability of truth or a Sybil-resistance guarantee";

/**
 * The originating reporter's ADVISORY, NON-GATING standing, surfaced to the
 * reviewer as triage context only. Component signals (device trust, reliability
 * lower bound, corroboration, tenure, last-active) are presented rather than a
 * single blended score — components are more honest for a triage decision. This
 * NEVER feeds routing, the Beta posterior, confidence, or the accept/reject
 * outcome; the reviewer's decision must be about the OBSERVATION's content.
 */
export interface ReporterSignal {
  /** The originating reporter's key thumbprint. */
  keyId: string;
  /**
   * The reporter's account status ("active" | "blocked"). Surfaced so a reviewer
   * triaging a flagged report can see the originator is already blocked — a
   * strong triage signal — without a second lookup. Advisory context only; the
   * accept/reject decision stays about the observation's content.
   */
  status: string;
  /** The device-trust signal (nullable until the key re-enrolls post-#1). */
  trustSignal: number | null;
  /** One-sided lower credible bound of the Beta posterior at the advisory level. */
  reliabilityLowerBound: number;
  /** Distinct pre-cutoff confirmations this reporter earned. */
  corroboratedCount: number;
  /** Age of the reporter key in days: `(now − created_at)/86400000`. */
  tenureDays: number;
  /**
   * When the posterior was last touched. The raw posterior carries no inactivity
   * decay, so a dormant reporter's reliability is stale — this makes that legible.
   */
  lastActiveAt: string;
  /** The advisory disclaimer ({@link ADVISORY_REPUTATION_NOTE}). */
  note: string;
}

export interface FlaggedItem {
  observationId: string;
  flaggedAt: string;
  evidenceState: string | null;
  type: string | null;
  geometry: GeoJsonGeometry;
  /** Count of distinct flag sub_claims naming this observation (0 for auto-flags). */
  flagCount: number;
  /** The non-empty reason strings from those flag sub_claims. */
  flagReasons: string[];
  /**
   * The originating reporter's advisory signals, or null when the flagged
   * observation has no originating key (a federated row, or a keyless auto-flag).
   * READ-ONLY triage context — see {@link ReporterSignal}.
   */
  reporter: ReporterSignal | null;
}

export interface FlaggedPage {
  items: FlaggedItem[];
  /** Composite keyset cursor: the last item's `flaggedAt`, or null at the end. */
  nextBefore: string | null;
  /** Composite keyset cursor: the last item's observation `id`, or null. */
  nextBeforeId: string | null;
}

export interface ListFlaggedParams {
  /** Page size; clamped to [1, 200], default 50. */
  limit?: number;
  /**
   * Composite keyset cursor (with `beforeId`): the previous page's last
   * `flaggedAt`. Supply both `before` and `beforeId` together, or neither.
   */
  before?: string;
  /**
   * Composite keyset cursor (with `before`): the previous page's last
   * observation `id`, tie-breaking rows that share `before`'s `flaggedAt`.
   */
  beforeId?: string;
  /**
   * The "now" instant used to derive each reporter's `tenureDays`. ISO 8601;
   * defaults to the wall clock. Injected so the surface is deterministic in tests.
   */
  now?: string;
}

interface FlaggedRow {
  id: string;
  flagged_at: Date;
  evidence_state: string | null;
  type: string | null;
  geojson: string;
  flag_count: number;
  flag_reasons: string[] | null;
  reporter_key_id: string | null;
  reporter_status: string | null;
  reporter_trust_signal: number | null;
  reporter_alpha: number | null;
  reporter_beta: number | null;
  reporter_corroborated_count: number | null;
  reporter_created_at: Date | null;
  reporter_last_active_at: Date | null;
}

const MILLIS_PER_DAY = 86_400_000;

/**
 * Build the originating reporter's advisory signal from a joined row, or null
 * when there is no originating key / no reporter row (federated or keyless flag).
 * Gating on the posterior's presence keeps a dangling key from crashing the
 * `reliabilityLowerBound` computation.
 */
function reporterSignalFrom(row: FlaggedRow, nowMs: number): ReporterSignal | null {
  if (
    row.reporter_key_id === null ||
    row.reporter_alpha === null ||
    row.reporter_beta === null ||
    row.reporter_last_active_at === null
  ) {
    return null;
  }
  const createdMs = row.reporter_created_at ? row.reporter_created_at.getTime() : nowMs;
  return {
    keyId: row.reporter_key_id,
    status: row.reporter_status ?? "active",
    trustSignal: row.reporter_trust_signal,
    reliabilityLowerBound: reliabilityLowerBound(
      { alpha: row.reporter_alpha, beta: row.reporter_beta },
      ADVISORY_CREDIBLE_LEVEL
    ),
    corroboratedCount: row.reporter_corroborated_count ?? 0,
    tenureDays: (nowMs - createdMs) / MILLIS_PER_DAY,
    lastActiveAt: row.reporter_last_active_at.toISOString(),
    note: ADVISORY_REPUTATION_NOTE,
  };
}

/** Clamp a requested page size into [1, MAX_LIMIT], defaulting when absent/invalid. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/**
 * List the open-flagged observations, newest flag first, with a composite
 * `(flagged_at, id)` keyset cursor. The cursor is the previous page's last row:
 * `before` (its `flaggedAt`) and `beforeId` (its `id`), supplied together or
 * both absent for the first page. The row-wise predicate mirrors the
 * `ORDER BY flagged_at DESC, id DESC`, so rows sharing a `flagged_at` at a page
 * boundary are tie-broken by `id` and never skipped.
 *
 * Each item also carries the originating reporter's advisory {@link ReporterSignal}
 * (or null). The originating key is resolved via a LATERAL `LIMIT 1` over
 * `report_evidence` — a plain join would multiply rows and corrupt the keyset
 * cursor/pagination, so the LIMIT-1 is load-bearing: it is strictly per-row and
 * cannot change the ordering, the limit, or the row count.
 */
export async function listFlagged(sql: Sql, params: ListFlaggedParams = {}): Promise<FlaggedPage> {
  const limit = clampLimit(params.limit);
  const before = params.before ?? null;
  const beforeId = params.beforeId ?? null;
  // A malformed `params.now` (only server code supplies it, but be defensive)
  // must not silently produce NaN tenureDays — fall back to the wall clock.
  const parsedNow = params.now ? Date.parse(params.now) : Date.now();
  const nowMs = Number.isNaN(parsedNow) ? Date.now() : parsedNow;

  const rows = await sql<FlaggedRow[]>`
    SELECT o.id, o.flagged_at, o.evidence_state, o.type,
           ST_AsGeoJSON(o.geom) AS geojson,
           COALESCE(f.flag_count, 0) AS flag_count,
           f.flag_reasons AS flag_reasons,
           orig.actor_key_id AS reporter_key_id,
           r.status AS reporter_status,
           r.trust_signal AS reporter_trust_signal,
           r.reputation_alpha AS reporter_alpha,
           r.reputation_beta AS reporter_beta,
           r.corroborated_count AS reporter_corroborated_count,
           r.created_at AS reporter_created_at,
           r.last_active_at AS reporter_last_active_at
    FROM conditions.observations o
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS flag_count,
             array_remove(array_agg(sc.reason), NULL) AS flag_reasons
      FROM conditions.sub_claim sc
      WHERE sc.subject_id = o.id AND sc.claim_type = 'flag'
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT re.actor_key_id
      FROM conditions.report_evidence re
      WHERE re.observation_id = o.id AND re.evidence_kind = 'report'
      ORDER BY re.occurred_at, re.id
      LIMIT 1
    ) orig ON true
    LEFT JOIN conditions.reporter r ON r.key_id = orig.actor_key_id
    WHERE o.flagged_at IS NOT NULL
      AND o.status = 'active'
      AND (
        ${before}::timestamptz IS NULL
        OR o.flagged_at < ${before}::timestamptz
        OR (o.flagged_at = ${before}::timestamptz AND o.id < ${beforeId}::text)
      )
    ORDER BY o.flagged_at DESC, o.id DESC
    LIMIT ${limit}
  `;

  const items: FlaggedItem[] = rows.map((row) => ({
    observationId: row.id,
    flaggedAt: row.flagged_at.toISOString(),
    evidenceState: row.evidence_state,
    type: row.type,
    geometry: JSON.parse(row.geojson) as GeoJsonGeometry,
    flagCount: row.flag_count,
    flagReasons: row.flag_reasons ?? [],
    reporter: reporterSignalFrom(row, nowMs),
  }));

  // Only advertise a next cursor when the page was full — otherwise the client
  // has reached the end. Both cursor fields come from the last row and are
  // supplied back together on the next request.
  const full = items.length === limit && items.length > 0;
  const last = full ? rows[rows.length - 1]! : null;
  const nextBefore = last ? last.flagged_at.toISOString() : null;
  const nextBeforeId = last ? last.id : null;

  return { items, nextBefore, nextBeforeId };
}
