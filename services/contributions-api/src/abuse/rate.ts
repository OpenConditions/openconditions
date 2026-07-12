import type postgres from "postgres";
import { coarseCell } from "@openconditions/core";

type Sql = postgres.Sql;

/** Ceilings for one key's landed reports inside a trailing window. */
export interface RateRule {
  windowSec: number;
  /** Max `report` evidence rows for the key anywhere inside the window. */
  maxPerKey: number;
  /** Max `report` evidence rows for the key inside ONE coarse cell (~1km). */
  maxPerKeyCell: number;
}

/** Default report-landing rule: 10/min per key, 4/min per key per ~1km cell. */
export const REPORT_RATE_RULE: RateRule = {
  windowSec: 60,
  maxPerKey: 10,
  maxPerKeyCell: 4,
};

export interface RateDecision {
  ok: boolean;
  /** Which ceiling was hit; absent when ok. */
  reason?: "per-key" | "per-key-cell";
}

/**
 * Per-(key, area, window) report-rate guard. Counts the key's landed `report`
 * evidence rows in the trailing window — total AND within the coarse cell of
 * (lon, lat) — in one query, and refuses when either ceiling is already
 * reached. The per-cell count filters on `details->>'cell'`, which the landing
 * stamps on every report evidence row via {@link coarseCell}, so the area
 * bucketing needs no geometry join. The cell function is a swappable seam (an
 * equal-intent substitute for H3 area bucketing).
 *
 * This is an admission-rate guard against flooding, not a truth judgment: a
 * breach is a 429 at the route, never a flag on any landed observation.
 */
export async function checkReportRate(
  sql: Sql,
  keyId: string,
  lon: number,
  lat: number,
  now: string,
  rule: RateRule = REPORT_RATE_RULE
): Promise<RateDecision> {
  const cell = coarseCell(lon, lat);
  const rows = await sql<{ total: number; in_cell: number }[]>`
    SELECT count(*)::int AS total,
           (count(*) FILTER (WHERE details->>'cell' = ${cell}))::int AS in_cell
    FROM conditions.report_evidence
    WHERE actor_key_id = ${keyId}
      AND evidence_kind = 'report'
      AND occurred_at > ${now}::timestamptz - make_interval(secs => ${rule.windowSec})
  `;
  const counts = rows[0] ?? { total: 0, in_cell: 0 };
  if (counts.total >= rule.maxPerKey) {
    return { ok: false, reason: "per-key" };
  }
  if (counts.in_cell >= rule.maxPerKeyCell) {
    return { ok: false, reason: "per-key-cell" };
  }
  return { ok: true };
}
