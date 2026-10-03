import type { FlowBaseline } from "@openconditions/roads";
import type postgres from "postgres";

type Sql = postgres.Sql;

/**
 * Returns the free-flow baseline of each measurement site of a source, by the
 * subject key of its `traffic.speed` series (`feature:<featureId>`), resolved
 * from the OVERALL (dow_bucket = -1, tod_bucket = -1) row only, preferring
 * method native > derived > osm_maxspeed. The method is threaded so the
 * enrichment can name where the free-flow speed came from. A plain Map so
 * packages/roads stays DB-free.
 *
 * The per-(dow,tod)-bucket rows deriveBaselines also writes are intentionally
 * NOT read here: they are a rolling *typical speed for that hour* (kept for a
 * future typical-speed feature), which is not the same thing as a *free-flow*
 * denominator. Using a congested rush-hour bucket's own p85 as the free-flow
 * baseline would make recurring rush-hour congestion measure against itself
 * and misclassify as free_flow exactly when a traffic layer should show
 * congestion — this is the P0.3 fix; do not reintroduce a specific-bucket
 * preference here.
 */
export async function loadBaselineMap(
  sql: Sql,
  source: string,
): Promise<Map<string, FlowBaseline>> {
  const rows = await sql<
    { subject_key: string; free_flow_kph: number; method: FlowBaseline["method"] }[]
  >`
    SELECT DISTINCT ON (subject_key) subject_key, free_flow_kph, method
    FROM conditions.sensor_baseline
    WHERE source = ${source} AND dow_bucket = -1 AND tod_bucket = -1
    ORDER BY subject_key, (CASE method WHEN 'native' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END)`;
  return new Map(
    rows.map((r) => [r.subject_key, { freeFlowKph: r.free_flow_kph, method: r.method }]),
  );
}
