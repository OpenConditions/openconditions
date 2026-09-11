import postgres from "postgres";

export interface PollAttempt {
  source: string;
  outcome: string;
  attemptedAt: string;
  freshnessWindowSec: number;
}

export interface SourceReadiness {
  source: string;
  networkAttempts: number;
  successfulValidations: number;
  failed: number;
  partial: number;
  skippedCadence: number;
  skippedOverlap: number;
  missingConfiguration: number;
  recordedAttempts: number;
  networkReliability: number | null;
  networkReliabilityReady: boolean;
  observedFrom: string | null;
  observedThrough: string | null;
  observedSpanSeconds: number;
  maxValidationGapSeconds: number | null;
  sevenDayCoverageReady: boolean;
  noFreshnessGaps: boolean;
  /** Poll-only soak result. Graph, rights, policy and binding gates remain separate. */
  pollSoakReady: boolean;
}

const NETWORK_OUTCOMES = new Set([
  "changed",
  "validated_unchanged",
  "complete_empty",
  "partial",
  "failed",
]);
const SUCCESS_OUTCOMES = new Set(["changed", "validated_unchanged", "complete_empty"]);
const SEVEN_DAYS_MS = 7 * 86_400_000;

export function assessReadiness(rows: PollAttempt[], now: Date = new Date()): SourceReadiness[] {
  const grouped = new Map<string, PollAttempt[]>();
  for (const row of rows) {
    const attempts = grouped.get(row.source) ?? [];
    attempts.push(row);
    grouped.set(row.source, attempts);
  }

  return [...grouped.entries()]
    .map(([source, attempts]) => {
      const outcomeCount = (outcome: string) =>
        attempts.reduce((sum, attempt) => sum + (attempt.outcome === outcome ? 1 : 0), 0);
      const networkAttempts = attempts.filter((attempt) => NETWORK_OUTCOMES.has(attempt.outcome));
      const successful = attempts
        .filter((attempt) => SUCCESS_OUTCOMES.has(attempt.outcome))
        .map((attempt) => Date.parse(attempt.attemptedAt))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const networkReliability =
        networkAttempts.length > 0 ? successful.length / networkAttempts.length : null;
      const freshnessWindowSec = Math.max(
        0,
        ...attempts.map((attempt) => Number(attempt.freshnessWindowSec) || 0)
      );
      const freshnessWindowMs = freshnessWindowSec * 1_000;
      const nowMs = now.getTime();
      const windowStart = nowMs - SEVEN_DAYS_MS;
      const first = successful[0];
      const last = successful.at(-1);
      const validationGaps = successful.slice(1).map((at, i) => at - successful[i]!);
      const maxValidationGapMs = validationGaps.length > 0 ? Math.max(...validationGaps) : null;
      const sevenDayCoverageReady =
        first != null &&
        last != null &&
        freshnessWindowMs > 0 &&
        first <= windowStart + freshnessWindowMs &&
        last >= nowMs - freshnessWindowMs;
      const noFreshnessGaps =
        freshnessWindowMs > 0 &&
        maxValidationGapMs != null &&
        maxValidationGapMs <= freshnessWindowMs;
      const networkReliabilityReady = networkReliability != null && networkReliability >= 0.99;

      return {
        source,
        networkAttempts: networkAttempts.length,
        successfulValidations: successful.length,
        failed: outcomeCount("failed"),
        partial: outcomeCount("partial"),
        skippedCadence: outcomeCount("skipped_cadence"),
        skippedOverlap: outcomeCount("skipped_overlap"),
        missingConfiguration: outcomeCount("missing_configuration"),
        recordedAttempts: attempts.length,
        networkReliability,
        networkReliabilityReady,
        observedFrom: first == null ? null : new Date(first).toISOString(),
        observedThrough: last == null ? null : new Date(last).toISOString(),
        observedSpanSeconds: first == null || last == null ? 0 : (last - first) / 1_000,
        maxValidationGapSeconds: maxValidationGapMs == null ? null : maxValidationGapMs / 1_000,
        sevenDayCoverageReady,
        noFreshnessGaps,
        pollSoakReady: networkReliabilityReady && sevenDayCoverageReady && noFreshnessGaps,
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source));
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<
      {
        source: string;
        outcome: string;
        attempted_at: Date | string;
        freshness_window_sec: number;
      }[]
    >`
      SELECT a.source, a.outcome, a.attempted_at, s.freshness_window_sec
      FROM conditions.source_poll_attempt a
      JOIN conditions.source_status s ON s.source = a.source
      WHERE a.attempted_at >= now() - interval '7 days'
      ORDER BY a.source, a.attempted_at`;
    const attempts = rows.map((row) => ({
      source: row.source,
      outcome: row.outcome,
      attemptedAt: new Date(row.attempted_at).toISOString(),
      freshnessWindowSec: row.freshness_window_sec,
    }));
    process.stdout.write(
      `${JSON.stringify({ windowDays: 7, sources: assessReadiness(attempts) }, null, 2)}\n`
    );
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
