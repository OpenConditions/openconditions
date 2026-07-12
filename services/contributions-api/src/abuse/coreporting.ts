import type postgres from "postgres";

type Sql = postgres.Sql;

export interface CoReportingPair {
  /** Lexicographically smaller key of the pair. */
  keyA: string;
  keyB: string;
  /** Distinct phenomenon fingerprints both keys reported since `sinceIso`. */
  sharedCount: number;
}

/**
 * MONITORING ONLY — a read-only observability query that surfaces pairs of
 * reporter keys co-reporting the same phenomenonFingerprint suspiciously often
 * (a collusion-ring smell). It is deliberately wired into NO accept/reject
 * path: it never gates a landing, a vote, or a resolution, and it writes
 * nothing. Findings feed a human/ops review; any consequence (blocking a key)
 * is a separate, accountable decision.
 *
 * The fingerprint itself is time-bucketed, so a shared fingerprint already
 * means "same typed place at roughly the same time"; `sinceIso` bounds the
 * scan window.
 */
export async function coReportingClusters(
  sql: Sql,
  sinceIso: string,
  minShared = 3
): Promise<CoReportingPair[]> {
  return sql<CoReportingPair[]>`
    WITH reports AS (
      SELECT DISTINCT e.actor_key_id AS key_id, o.phenomenon_fingerprint AS fingerprint
      FROM conditions.report_evidence e
      JOIN conditions.observations o ON o.id = e.observation_id
      WHERE e.evidence_kind = 'report'
        AND e.actor_key_id IS NOT NULL
        AND e.occurred_at >= ${sinceIso}::timestamptz
        AND o.phenomenon_fingerprint IS NOT NULL
    )
    SELECT a.key_id AS "keyA", b.key_id AS "keyB", count(*)::int AS "sharedCount"
    FROM reports a
    JOIN reports b ON b.fingerprint = a.fingerprint AND a.key_id < b.key_id
    GROUP BY a.key_id, b.key_id
    HAVING count(*) >= ${minShared}
    ORDER BY count(*) DESC, a.key_id, b.key_id
  `;
}
