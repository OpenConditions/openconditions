import { CONTRIBUTOR_RECEIPT_VERSION } from "@openconditions/core";
import { type Attribution, type MergedSource, publicAttributionOf } from "@openconditions/model";
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
    {
      subject_key: string;
      free_flow_kph: number;
      method: FlowBaseline["method"];
      provenances:
        | { sourceId: string; attribution: Attribution; upstream?: MergedSource["upstream"] }[]
        | null;
    }[]
  >`
    SELECT DISTINCT ON (subject_key) subject_key, free_flow_kph, method,
      (SELECT jsonb_agg(r.provenance) FROM unnest(b.contributor_receipt_ids) ids
        JOIN conditions.contributor_receipt r ON r.id=ids AND r.version=${CONTRIBUTOR_RECEIPT_VERSION}) AS provenances
    FROM conditions.sensor_baseline b
    WHERE source = ${source} AND dow_bucket = -1 AND tod_bucket = -1
      AND (method <> 'derived' OR (lineage_complete
        AND conditions.flow_public_licenses(permission_licenses)
        AND conditions.flow_receipt_permissions(contributor_receipt_ids,lineage_complete,${CONTRIBUTOR_RECEIPT_VERSION}) IS NOT NULL
        AND contributing = ARRAY[b.source]
        AND NOT EXISTS(SELECT 1 FROM unnest(contributing) ids LEFT JOIN conditions.source s ON s.id=ids WHERE s.id IS NULL OR s.restricted)))
    ORDER BY subject_key, (CASE method WHEN 'native' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END)`;
  return new Map(
    rows.map((r) => {
      const upstream =
        r.method === "derived"
          ? (r.provenances ?? []).flatMap((p) => [
              {
                source: { sourceId: p.sourceId, attribution: publicAttributionOf(p.attribution) },
                publisher:
                  p.attribution.publisher?.name ?? p.attribution.name ?? p.attribution.provider,
                license: p.attribution.license,
                ...(p.attribution.licensing ? { licensing: p.attribution.licensing } : {}),
                attribution: p.attribution.provider,
              },
              ...(p.upstream ?? []),
            ])
          : undefined;
      return [
        r.subject_key,
        {
          freeFlowKph: r.free_flow_kph,
          method: r.method,
          ...(upstream?.length
            ? { upstream: [...new Map(upstream.map((u) => [JSON.stringify(u), u])).values()] }
            : {}),
        },
      ];
    }),
  );
}
