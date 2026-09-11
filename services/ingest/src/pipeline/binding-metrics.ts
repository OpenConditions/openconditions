import type postgres from "postgres";

type Sql = postgres.Sql;

/** Binding outcomes of one source: how many events the resolver attempted, split by outcome. */
export interface BindingMetrics {
  activeEvents: number;
  attempted: number;
  attemptedCurrent: number;
  unattempted: number;
  obsolete: number;
  unattemptedOrObsolete: number;
  unknownStatus: number;
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
    activeEvents: 0,
    attempted: 0,
    attemptedCurrent: 0,
    unattempted: 0,
    obsolete: 0,
    unattemptedOrObsolete: 0,
    unknownStatus: 0,
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
    const rows = await sql<
      { source: string; status: string | null; binding_current: boolean; n: number }[]
    >`
      SELECT o.source, b.status,
        CASE WHEN b.status IS NULL OR b.status = 'obsolete' THEN false
          WHEN g.generation IS NULL THEN false
          ELSE b.observation_revision IS NOT DISTINCT FROM o.content_hash
            AND b.observation_revision IS NOT NULL
            AND b.graph_generation IS NOT DISTINCT FROM g.generation
            AND b.graph_generation IS NOT NULL
        END AS binding_current,
        count(*)::int AS n
      FROM conditions.observations o
      LEFT JOIN conditions.observation_binding b ON b.observation_id = o.id
      LEFT JOIN conditions.road_graph_state g ON g.singleton
      WHERE o.kind = 'event'
        AND o.status NOT IN ('cancelled', 'archived')
        AND (o.expires_at IS NULL OR o.expires_at > now())
      GROUP BY o.source, b.status, binding_current`;
    const value = new Map<string, BindingMetrics>();
    for (const row of rows) {
      const metrics = value.get(row.source) ?? emptyMetrics();
      metrics.activeEvents += row.n;
      if (row.status == null) {
        metrics.unattempted += row.n;
        metrics.unattemptedOrObsolete += row.n;
      } else {
        metrics.attempted += row.n;
        if (row.status === "obsolete" || !row.binding_current) {
          metrics.obsolete += row.n;
          metrics.unattemptedOrObsolete += row.n;
        } else {
          metrics.attemptedCurrent += row.n;
          const key = STATUS_KEYS[row.status];
          if (key) metrics[key] += row.n;
          else metrics.unknownStatus += row.n;
        }
      }
      value.set(row.source, metrics);
    }
    cache = { at: Date.now(), value };
    return value;
  };
}
