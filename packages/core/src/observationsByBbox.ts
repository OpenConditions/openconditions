import type { FeatureCollection, Feature, Geometry } from "geojson";
import type { Sql } from "postgres";

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

/**
 * Query active observations within a bounding box and return a GeoJSON FeatureCollection.
 * The caller supplies their postgres-js `sql` tagged-template client; this helper
 * issues a single parameterised PostGIS query and maps the rows into Features.
 *
 * @param sql   postgres-js tagged-template client from the caller (no runtime postgres import here)
 * @param opts  domain, bbox [west, south, east, north], optional type filter
 */
export async function observationsByBbox(
  sql: Sql,
  opts: ObservationsByBboxOpts,
): Promise<FeatureCollection> {
  const { domain, bbox, types } = opts;
  const [west, south, east, north] = bbox;
  const typesFilter = types && types.length > 0 ? types : null;

  const rows = await sql<ObservationRow[]>`
    SELECT
      id, source, domain, kind, type, severity,
      headline, description, attributes, valid_to,
      ST_AsGeoJSON(geom) AS geojson,
      origin, is_stale
    FROM conditions.observations
    WHERE
      domain = ${domain}
      AND geom && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)
      AND status = 'active'
      AND (${typesFilter}::text[] IS NULL OR type = ANY(${typesFilter}::text[]))
    ORDER BY severity DESC NULLS LAST
    LIMIT 2000
  `;

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
