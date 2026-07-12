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
  /**
   * Restrict to observations that may affect ROUTING. Feed observations are
   * authoritative and always kept; a crowd observation is kept only once it is
   * `routing_eligible` (an external resolution made it so — peer corroboration
   * never does). The routing path passes `true` so a single self-reported crowd
   * closure never becomes a Valhalla exclusion; the map/label path leaves this
   * `false` (default) and takes ALL rows, just labeled. See the origin-aware
   * WHERE clause below.
   */
  routingEligibleOnly?: boolean;
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
  valid_from: string | null;
  valid_to: string | null;
  schedule: unknown;
  data_updated_at: string | Date | null;
  geojson: string;
  origin: { kind: string; attribution?: { provider?: string; license?: string; url?: string } };
  is_stale: boolean;
  evidence_state: string | null;
  routing_eligible: boolean | null;
  confidence_score: number | null;
  privacy_class: string | null;
  fuzziness: string | null;
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
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      schedule: row.schedule ?? undefined,
      data_updated_at:
        row.data_updated_at instanceof Date
          ? row.data_updated_at.toISOString()
          : (row.data_updated_at ?? null),
      is_stale: row.is_stale,
      attribution,
      // Evidence labeling: the overlay + provider render a crowd report distinctly
      // (e.g. "clearly unconfirmed") and the routing path filters on these. Feed
      // rows carry null evidence_state/routing_eligible and are authoritative.
      originKind: row.origin?.kind,
      evidenceState: row.evidence_state ?? undefined,
      routingEligible: row.routing_eligible ?? undefined,
      confidenceScore: row.confidence_score ?? undefined,
      privacyClass: row.privacy_class ?? undefined,
      fuzziness: row.fuzziness ?? undefined,
      ...(mergedSources && mergedSources.length > 0 ? { mergedSources } : {}),
    },
  };
}

// Severity ordering for ORDER BY / minSeverity (mirrors core's severityRank).
const SEVERITY_RANK_SQL =
  "(CASE o.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END)";

// A source is stale when it has no source_status row at all (never
// registered a successful poll) or its last success is older than its own
// freshness window. Joined rather than read from the row's own
// fetched_at/stale_after: the diff-upsert swap leaves an unchanged row's
// fetched_at untouched, so per-row freshness would flag a healthy-but-static
// row as stale even though its source just polled successfully.
const IS_STALE_SQL =
  "(ss.last_success_at IS NULL OR ss.last_success_at + make_interval(secs => ss.freshness_window_sec) < now())";

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
    "o.domain = $1",
    "o.geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)",
    "o.status = 'active'",
    // Never serve a condition past its validity/expiry, even if a stale row is
    // still present (e.g. between sweeps, or from a source that stopped polling).
    "(o.valid_to IS NULL OR o.valid_to > now())",
    "(o.expires_at IS NULL OR o.expires_at > now())",
  ];

  if (kind != null) {
    params.push(kind);
    clauses.push(`o.kind = $${params.length}`);
  }

  if (Array.isArray(types) && types.length > 0) {
    params.push(types);
    clauses.push(`o.type = ANY($${params.length}::text[])`);
  }
  if (minSeverity != null) {
    params.push(severityRank(minSeverity));
    clauses.push(`${SEVERITY_RANK_SQL} >= $${params.length}`);
  }
  // Origin-aware routing gate: keep every feed row (authoritative), keep a crowd
  // row only once it is routing_eligible. A crowd row with routing_eligible
  // false/NULL is excluded here so a lone self-reported closure never routes.
  if (opts.routingEligibleOnly === true) {
    clauses.push(
      "NOT (o.origin->>'kind' = 'crowd' AND COALESCE(o.routing_eligible, false) IS NOT TRUE)"
    );
  }

  const query = `
    SELECT
      o.id, o.source, o.domain, o.kind, o.type, o.severity,
      o.headline, o.description, o.attributes, o.valid_from, o.valid_to, o.schedule, o.data_updated_at,
      ST_AsGeoJSON(o.geom) AS geojson,
      o.origin,
      o.evidence_state, o.routing_eligible, o.confidence_score, o.privacy_class, o.fuzziness,
      ${IS_STALE_SQL} AS is_stale
    FROM conditions.observations o
    LEFT JOIN conditions.source_status ss ON ss.source = o.source
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
