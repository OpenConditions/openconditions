import type { FeatureCollection, Feature, Geometry } from "geojson";
import { dedupeAcrossSources } from "./crossSourceDedupe.js";
import type { Observation, Provenance } from "./model.js";
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
  /**
   * Restrict to one observation kind (e.g. `"event"`). The store mixes incident
   * events with high-frequency `"measurement"` rows (traffic-flow speeds); an
   * incident overlay passes `"event"` so it never serves the (potentially tens
   * of thousands of) flow measurements.
   */
  kind?: string;
  /**
   * Collapse cross-source duplicate events (the aggregator dedup) before
   * returning. On by default; pass `false` for a raw, per-source view. See
   * `dedupeAcrossSources`.
   */
  dedupe?: boolean;
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
  data_updated_at: string | Date | null;
  geojson: string;
  origin: { kind: string; attribution?: { provider?: string; license?: string; url?: string } };
  is_stale: boolean;
}

/**
 * Build the minimal Observation the cross-source dedup needs from a query row:
 * the dedup predicate reads kind/source/type/geometry/roads, richness reads
 * geometry + description + roads/lanes/restrictions/detour, and the survivor
 * keeps `dataUpdatedAt` for the newest-tiebreak and `origin` for attribution.
 */
function rowToDedupeObservation(row: ObservationRow): Observation {
  const updated = row.data_updated_at;
  return {
    id: row.id,
    source: row.source,
    sourceFormat: "native",
    domain: row.domain,
    kind: row.kind as Observation["kind"],
    geometry: JSON.parse(row.geojson) as Geometry,
    status: "active",
    dataUpdatedAt: updated instanceof Date ? updated.toISOString() : (updated ?? ""),
    fetchedAt: "",
    isStale: row.is_stale,
    origin: row.origin as Provenance,
    ...(row.type != null ? { type: row.type } : {}),
    ...(row.description != null ? { description: row.description } : {}),
    ...(row.attributes ?? {}),
  } as unknown as Observation;
}

/** Project a row to its GeoJSON feature, optionally carrying merged source refs. */
function rowToFeature(row: ObservationRow, mergedSources?: Observation["mergedSources"]): Feature {
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
      ...(mergedSources && mergedSources.length > 0 ? { mergedSources } : {}),
    },
  };
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
  const { domain, bbox, types, minSeverity, kind } = opts;
  const [west, south, east, north] = bbox;

  const params: unknown[] = [domain, west, south, east, north];
  const clauses = [
    "domain = $1",
    "geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)",
    "status = 'active'",
    // Never serve a condition past its validity/expiry, even if a stale row is
    // still present (e.g. between sweeps, or from a source that stopped polling).
    "(valid_to IS NULL OR valid_to > now())",
    "(expires_at IS NULL OR expires_at > now())",
  ];

  if (kind != null) {
    params.push(kind);
    clauses.push(`kind = $${params.length}`);
  }

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
      headline, description, attributes, valid_to, data_updated_at,
      ST_AsGeoJSON(geom) AS geojson,
      origin,
      (stale_after IS NOT NULL AND stale_after < now()) AS is_stale
    FROM conditions.observations
    WHERE ${clauses.join(" AND ")}
    ORDER BY ${SEVERITY_RANK_SQL} DESC
    LIMIT 2000`;

  const rows = (await db.execute<ObservationRow[]>(query, params)) ?? [];

  if (opts.dedupe === false) {
    return { type: "FeatureCollection", features: rows.map((row) => rowToFeature(row)) };
  }

  // Collapse cross-source duplicates on the model, then project the survivors
  // (mapped back to their original rows by id) so the feature shape is unchanged.
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const survivors = dedupeAcrossSources(rows.map(rowToDedupeObservation));
  const features: Feature[] = [];
  for (const s of survivors) {
    const row = rowById.get(s.id);
    if (row) features.push(rowToFeature(row, s.mergedSources));
  }

  return { type: "FeatureCollection", features };
}
