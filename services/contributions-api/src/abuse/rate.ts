import { coarseCell } from "@openconditions/core";
import type postgres from "postgres";
import { lockCrowd } from "../crowd.js";

type Sql = postgres.Sql | postgres.TransactionSql;

export class ReportRateLimitError extends Error {
  constructor(readonly reason: "per-key" | "per-key-cell") {
    super("too many reports; slow down");
    this.name = "ReportRateLimitError";
  }
}

/** Ceilings for one key's reports, landed or refused, inside a trailing window. */
export interface RateRule {
  windowSec: number;
  /** Max reports of the key anywhere inside the window. */
  maxPerKey: number;
  /** Max reports of the key inside ONE coarse cell (~1km). */
  maxPerKeyCell: number;
}

/** Default report rule: 10/min per key, 4/min per key per ~1km cell. */
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
 * Per-(key, area, window) report-rate guard. Counts the key's reports in the
 * trailing window — its landed `report` rows, matching observation submissions
 * (`confirm` rows marked `via: same-reading`), and its refused reports
 * ({@link countRefusal}), total AND within the coarse cell of (lon, lat) — in
 * one query, and refuses when either ceiling is already reached. A landed
 * report's cell is `details->>'cell'`, which the landing stamps on every
 * report evidence row via {@link coarseCell}, so the area bucketing needs no
 * geometry join. The cell function is a swappable seam (an equal-intent
 * substitute for H3 area bucketing).
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
  rule: RateRule = REPORT_RATE_RULE,
): Promise<RateDecision> {
  const cell = coarseCell(lon, lat);
  const since = sql`${now}::timestamptz - make_interval(secs => ${rule.windowSec})`;
  const rows = await sql<{ total: number; in_cell: number }[]>`
    SELECT count(*)::int AS total,
           (count(*) FILTER (WHERE cell = ${cell}))::int AS in_cell
    FROM (
      SELECT details->>'cell' AS cell
      FROM conditions.report_evidence
      WHERE actor_key_id = ${keyId}
        AND (evidence_kind = 'report' OR (
          record_class = 'observation' AND evidence_kind = 'confirm'
          AND details->>'via' = 'same-reading'
        ))
        AND occurred_at > ${since}
      UNION ALL
      SELECT cell
      FROM conditions.report_refusal
      WHERE actor_key_id = ${keyId}
        AND occurred_at > ${since}
    ) AS reports
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

/**
 * Counts a report the instance refused against its key's rate. A key that has
 * already reached its rate is refused with {@link ReportRateLimitError} and
 * nothing is written, so refusals cannot flood the table either; otherwise
 * the refusal is recorded at (lon, lat)'s cell and refusals older than the
 * window are pruned. Runs in its own transaction: the landing's own was
 * rolled back with the refusal.
 *
 * @throws ReportRateLimitError when the key reports too fast.
 */
export async function countRefusal(
  sql: postgres.Sql,
  keyId: string,
  lon: number,
  lat: number,
  now: string,
  rule: RateRule = REPORT_RATE_RULE,
): Promise<void> {
  await sql.begin(async (tx) => {
    await lockCrowd(tx);
    const admission = await checkReportRate(tx, keyId, lon, lat, now, rule);
    if (!admission.ok) throw new ReportRateLimitError(admission.reason!);
    await tx`
      DELETE FROM conditions.report_refusal
      WHERE occurred_at <= ${now}::timestamptz - make_interval(secs => ${rule.windowSec})
    `;
    await tx`
      INSERT INTO conditions.report_refusal (actor_key_id, cell, occurred_at)
      VALUES (${keyId}, ${coarseCell(lon, lat)}, ${now})
    `;
  });
}
