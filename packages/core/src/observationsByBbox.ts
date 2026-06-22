import type { FeatureCollection, Feature, Geometry } from "geojson";
import { severityRank } from "./severity.js";

/**
 * Minimal query client this helper needs. Structurally identical to OpenMapX's
 * `IntegrationContext.db` (`DatabaseClient`) — `execute<T>(query, params)` runs a
 * positional-parameter SQL string and returns the rows. Any postgres-js client
 * wraps to this in one line: `{ execute: (q, p) => sql.unsafe(q, p) }`.
 */
export interface QueryRunner {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
}

export interface ObservationsByBboxOpts {
  domain: string;
  bbox: [number, number, number, number];
  types?: string[];
  minSeverity?: string;
}

interface ObservationRow {
  id: string;
  source: string;
  domain: string;
  kind: string;
  type: string | null;
  severity: string | null;
  headline: string | null;
  description: string | null;
  attributes: Record<string, unknown> | null;
  valid_to: string | null;
  geojson: string;
  origin: { kind: string; attribution?: { provider?: string; license?: string; url?: string } };
  is_stale: boolean;
}

// Severity ordering for ORDER BY / minSeverity (mirrors core's severityRank).
const SEVERITY_RANK_SQL =
  "(CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END)";

/**
 * Query active observations within a bounding box and return a GeoJSON FeatureCollection.
 *
 * Takes a `QueryRunner` (the OpenMapX `ctx.db` interface), so the overlay route works
 * against the host-provided database client directly — no postgres-js coupling here.
 *
 * @param db    `{ execute(query, params) }` — e.g. OpenMapX `ctx.db`
 * @param opts  domain, bbox [west, south, east, north], optional type/severity filters
 */
export async function observationsByBbox(
  db: QueryRunner,
  opts: ObservationsByBboxOpts
): Promise<FeatureCollection> {
  const { domain, bbox, types, minSeverity } = opts;
  const [west, south, east, north] = bbox;

  const params: unknown[] = [domain, west, south, east, north];
  const clauses = [
    "domain = $1",
    "geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)",
    "status = 'active'",
  ];

  if (Array.isArray(types) && types.length > 0) {
    params.push(types);
    clauses.push(`type = ANY($${params.length}::text[])`);
  }
  if (minSeverity != null) {
    params.push(severityRank(minSeverity));
    clauses.push(`${SEVERITY_RANK_SQL} >= $${params.length}`);
  }

  const query = `
    SELECT
      id, source, domain, kind, type, severity,
      headline, description, attributes, valid_to,
      ST_AsGeoJSON(geom) AS geojson,
      origin, is_stale
    FROM conditions.observations
    WHERE ${clauses.join(" AND ")}
    ORDER BY ${SEVERITY_RANK_SQL} DESC
    LIMIT 2000`;

  const rows = (await db.execute<ObservationRow[]>(query, params)) ?? [];

  const features: Feature[] = rows.map((row) => {
    const geometry: Geometry = JSON.parse(row.geojson) as Geometry;
    const attribution = row.origin?.attribution ?? undefined;

    return {
      type: "Feature",
      geometry,
      properties: {
        id: row.id,
        source: row.source,
        domain: row.domain,
        kind: row.kind,
        type: row.type,
        severity: row.severity,
        headline: row.headline,
        description: row.description,
        attributes: row.attributes,
        valid_to: row.valid_to,
        is_stale: row.is_stale,
        attribution,
      },
    };
  });

  return { type: "FeatureCollection", features };
}
