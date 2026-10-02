import type postgres from "postgres";

type Sql = postgres.Sql;

export interface CoReportingPair {
  /** Lexicographically smaller key of the pair. */
  keyA: string;
  keyB: string;
  /** Distinct records both keys reported or confirmed since `sinceIso`. */
  sharedCount: number;
}

/**
 * MONITORING ONLY — a read-only observability query that surfaces pairs of
 * reporter keys co-reporting the same phenomenon suspiciously often (a
 * collusion-ring smell). It is deliberately wired into NO accept/reject path:
 * it never gates a landing, a vote, or a resolution, and it writes nothing.
 * Findings feed a human/ops review; any consequence (blocking a key) is a
 * separate, accountable decision.
 *
 * Two keys co-report a record when both stand in its ledger: one reported it
 * and the other confirmed it, or both reports were merged into it (a merged
 * reporter is a confirm on the survivor). `sinceIso` bounds the scan window.
 */
export async function coReportingClusters(
  sql: Sql,
  sinceIso: string,
  minShared = 3,
): Promise<CoReportingPair[]> {
  return sql<CoReportingPair[]>`
    WITH reports AS (
      SELECT DISTINCT e.actor_key_id AS key_id, e.record_class, e.record_id
      FROM conditions.report_evidence e
      WHERE e.evidence_kind IN ('report', 'confirm')
        AND e.actor_key_id IS NOT NULL
        AND e.occurred_at >= ${sinceIso}::timestamptz
    )
    SELECT a.key_id AS "keyA", b.key_id AS "keyB", count(*)::int AS "sharedCount"
    FROM reports a
    JOIN reports b ON b.record_class = a.record_class AND b.record_id = a.record_id
      AND a.key_id < b.key_id
    GROUP BY a.key_id, b.key_id
    HAVING count(*) >= ${minShared}
    ORDER BY count(*) DESC, a.key_id, b.key_id
  `;
}
