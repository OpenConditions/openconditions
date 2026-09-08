import type postgres from "postgres";

type Sql = postgres.Sql;

/** Binding outcomes of one source: how many events the resolver attempted, split by outcome. */
export interface BindingMetrics {
  attempted: number;
  exact: number;
  likely: number;
  ambiguous: number;
  unresolved: number;
  noCoverage: number;
  notApplicable: number;
}

/** Reads per-source binding metrics, keyed by `observations.source`. */
export type BindingMetricsReader = () => Promise<Map<string, BindingMetrics>>;

/** Maps the stored `observation_binding.status` values onto the reported keys. */
const STATUS_KEYS: Record<string, keyof Omit<BindingMetrics, "attempted">> = {
  exact: "exact",
  likely: "likely",
  ambiguous: "ambiguous",
  unresolved: "unresolved",
  no_coverage: "noCoverage",
  not_applicable: "notApplicable",
};

function emptyMetrics(): BindingMetrics {
  return {
    attempted: 0,
    exact: 0,
    likely: 0,
    ambiguous: 0,
    unresolved: 0,
    noCoverage: 0,
    notApplicable: 0,
  };
}

/**
 * Per-source binding outcome counts, cached for `ttlMs` so a status poll costs
 * at most one GROUP BY per refresh window. An unrecognised status still counts
 * toward `attempted` — the total must stay truthful even if the resolver grows
 * an outcome this reader does not know about yet.
 */
export function createBindingMetricsReader(sql: Sql, ttlMs = 60_000): BindingMetricsReader {
  let cache: { at: number; value: Map<string, BindingMetrics> } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.value;
    const rows = await sql<{ source: string; status: string; n: number }[]>`
      SELECT o.source, b.status, count(*)::int AS n
      FROM conditions.observation_binding b
      JOIN conditions.observations o ON o.id = b.observation_id
      GROUP BY o.source, b.status`;
    const value = new Map<string, BindingMetrics>();
    for (const row of rows) {
      const metrics = value.get(row.source) ?? emptyMetrics();
      metrics.attempted += row.n;
      const key = STATUS_KEYS[row.status];
      if (key) metrics[key] += row.n;
      value.set(row.source, metrics);
    }
    cache = { at: Date.now(), value };
    return value;
  };
}
