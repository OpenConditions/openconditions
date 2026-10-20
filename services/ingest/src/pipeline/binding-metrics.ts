import type postgres from "postgres";

type Sql = postgres.Sql;

/** Binding outcomes of one source: how many live situations the resolver attempted, by outcome. */
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
  /**
   * Current bindings that carry a reason, by status and reason: why a
   * location was not bound, or why one was kept off routing (its stated
   * direction contradicts it, or names a side the geometry cannot place).
   * `situations` counts situations' own locations, as the counts above do;
   * `effects` the bindings of effects with a place or a direction of their own.
   */
  reasons: BindingReasonCount[];
}

/** How many current bindings of one source have one status and reason. */
export interface BindingReasonCount {
  status: string;
  reason: string;
  situations: number;
  effects: number;
}

/** Reads per-source binding metrics, keyed by the situation's source id. */
export type BindingMetricsReader = () => Promise<Map<string, BindingMetrics>>;

/** Maps the stored `record_binding.status` values onto the reported keys. */
const STATUS_KEYS: Record<string, keyof Omit<BindingMetrics, "attempted" | "reasons">> = {
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
    reasons: [],
  };
}

/**
 * Per-source binding outcome counts, cached for `ttlMs` so a status poll costs
 * at most two GROUP BYs per refresh window. An unrecognised status still counts
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
      SELECT s.source_id AS source, b.status,
        CASE WHEN b.status IS NULL OR b.status = 'obsolete' THEN false
          WHEN g.generation IS NULL THEN false
          ELSE b.record_revision = s.revision
            AND b.graph_generation IS NOT DISTINCT FROM g.generation
            AND b.graph_generation IS NOT NULL
        END AS binding_current,
        count(*)::int AS n
      FROM conditions.situation s
      LEFT JOIN conditions.record_binding b ON b.record_class = 'situation'
        AND b.record_id = s.id AND b.effect_id = ''
      LEFT JOIN conditions.road_graph_state g ON g.singleton
      WHERE s.tombstoned_at IS NULL AND s.domain = 'roads'
        AND (s.expires_at IS NULL OR s.expires_at > now())
      GROUP BY s.source_id, b.status, binding_current`;
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
    // The reasons count the same live cohort, current bindings only: one
    // computed at the situation's revision on the active graph.
    const reasonRows = await sql<
      { source: string; status: string; reason: string; own: boolean; n: number }[]
    >`
      SELECT s.source_id AS source, b.status, b.reason, b.effect_id = '' AS own,
        count(*)::int AS n
      FROM conditions.situation s
      JOIN conditions.record_binding b ON b.record_class = 'situation' AND b.record_id = s.id
      JOIN conditions.road_graph_state g ON g.singleton AND b.graph_generation = g.generation
      WHERE s.tombstoned_at IS NULL AND s.domain = 'roads'
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND b.reason IS NOT NULL AND b.status <> 'obsolete'
        AND b.record_revision = s.revision
      GROUP BY s.source_id, b.status, b.reason, own
      ORDER BY s.source_id, b.status, b.reason`;
    for (const row of reasonRows) {
      const metrics = value.get(row.source) ?? emptyMetrics();
      let entry = metrics.reasons.find((r) => r.status === row.status && r.reason === row.reason);
      if (entry === undefined) {
        entry = { status: row.status, reason: row.reason, situations: 0, effects: 0 };
        metrics.reasons.push(entry);
      }
      if (row.own) entry.situations += row.n;
      else entry.effects += row.n;
      value.set(row.source, metrics);
    }
    cache = { at: Date.now(), value };
    return value;
  };
}
