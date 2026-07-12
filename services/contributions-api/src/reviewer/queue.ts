/**
 * The reviewer anomaly queue: the observations carrying an OPEN flag
 * (`flagged_at IS NOT NULL` AND `status = 'active'`), newest flag first. A flag
 * is a marker, not evidence, so the queue reads the observation's `flagged_at`
 * plus the flag `sub_claim` rows that name it — never the evidence ledger.
 * Auto-flags (kinematic/StreetComplete) set `flagged_at` with no sub_claim, so
 * an item's `flagCount` can legitimately be 0 with an empty `flagReasons`.
 */
import type postgres from "postgres";
import type { GeoJsonGeometry } from "@openconditions/core";

type Sql = postgres.Sql;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
}

export interface FlaggedPage {
  items: FlaggedItem[];
  /** Keyset cursor for the next page (the last item's `flaggedAt`), or null. */
  nextBefore: string | null;
}

export interface ListFlaggedParams {
  /** Page size; clamped to [1, 200], default 50. */
  limit?: number;
  /** Keyset cursor: only observations flagged strictly BEFORE this ISO instant. */
  before?: string;
}

interface FlaggedRow {
  id: string;
  flagged_at: Date;
  evidence_state: string | null;
  type: string | null;
  geojson: string;
  flag_count: number;
  flag_reasons: string[] | null;
}

/** Clamp a requested page size into [1, MAX_LIMIT], defaulting when absent/invalid. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/**
 * List the open-flagged observations, newest flag first, with keyset pagination
 * on `flagged_at`. `before` (exclusive) is the previous page's `nextBefore`.
 */
export async function listFlagged(sql: Sql, params: ListFlaggedParams = {}): Promise<FlaggedPage> {
  const limit = clampLimit(params.limit);
  const before = params.before ?? null;

  const rows = await sql<FlaggedRow[]>`
    SELECT o.id, o.flagged_at, o.evidence_state, o.type,
           ST_AsGeoJSON(o.geom) AS geojson,
           COALESCE(f.flag_count, 0) AS flag_count,
           f.flag_reasons AS flag_reasons
    FROM conditions.observations o
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS flag_count,
             array_remove(array_agg(sc.reason), NULL) AS flag_reasons
      FROM conditions.sub_claim sc
      WHERE sc.subject_id = o.id AND sc.claim_type = 'flag'
    ) f ON true
    WHERE o.flagged_at IS NOT NULL
      AND o.status = 'active'
      AND (${before}::timestamptz IS NULL OR o.flagged_at < ${before}::timestamptz)
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
  }));

  // Only advertise a next cursor when the page was full — otherwise the client
  // has reached the end.
  const nextBefore =
    items.length === limit && items.length > 0 ? items[items.length - 1]!.flaggedAt : null;

  return { items, nextBefore };
}
