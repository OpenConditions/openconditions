import type { Geometry } from "geojson";
import { dedupeAcrossSources } from "./crossSourceDedupe.js";
import type { ConditionEvent, Measurement, Observation, Provenance } from "./model.js";
import type { ObservationsByBboxOpts, QueryRunner } from "./observationsByBbox.js";
import { severityRank } from "./severity.js";

const SEVERITY_RANK_SQL =
  "(CASE o.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END)";

// See observationsByBbox.ts's IS_STALE_SQL for why this is a source_status
// join rather than the row's own stale_after/fetched_at.
const IS_STALE_SQL =
  "(ss.last_success_at IS NULL OR ss.last_success_at + make_interval(secs => ss.freshness_window_sec) < now())";

/** A `conditions.observations` row as selected by {@link readObservations};
 *  exported (with {@link rowToObservation}) so other readers of the same row
 *  shape — e.g. the federation outbox's point-in-time snapshots — reconstruct
 *  the canonical model through the one shared mapping. */
export interface ObservationRow {
  id: string;
  source: string;
  source_format: string;
  domain: string;
  kind: string;
  type: string | null;
  subtype: string | null;
  category: string | null;
  severity: string | null;
  severity_source: string | null;
  headline: string | null;
  description: string | null;
  label: string | null;
  metric: string | null;
  value: number | null;
  level: string | null;
  unit: string | null;
  aggregation: string | null;
  status: string;
  // postgres-js returns timestamptz as JS Date; coerced to ISO strings below.
  valid_from: string | Date | null;
  valid_to: string | Date | null;
  data_updated_at: string | Date;
  fetched_at: string | Date;
  expires_at: string | Date | null;
  schedule: Observation["schedule"] | null;
  confidence: string | null;
  is_forecast: boolean | null;
  related_ids: string[] | null;
  attributes: Record<string, unknown> | null;
  subject: Observation["subject"] | null;
  informed: Observation["informed"] | null;
  origin: Provenance;
  geojson: string;
  is_stale: boolean;
  evidence_state: string | null;
  routing_eligible: boolean | null;
}

/** Coerce a DB timestamp (Date from postgres-js, or string) to an ISO string. */
function iso(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export function rowToObservation(row: ObservationRow): Observation {
  const base = {
    id: row.id,
    source: row.source,
    sourceFormat: row.source_format as Observation["sourceFormat"],
    domain: row.domain,
    kind: row.kind as Observation["kind"],
    status: row.status as Observation["status"],
    geometry: JSON.parse(row.geojson) as Geometry,
    validFrom: iso(row.valid_from),
    validTo: iso(row.valid_to),
    dataUpdatedAt: iso(row.data_updated_at) ?? "",
    fetchedAt: iso(row.fetched_at) ?? "",
    expiresAt: iso(row.expires_at) ?? undefined,
    isStale: row.is_stale,
    origin: row.origin,
    ...(row.subject ? { subject: row.subject } : {}),
    ...(row.informed ? { informed: row.informed } : {}),
    ...(row.label != null ? { label: row.label } : {}),
    ...(row.schedule ? { schedule: row.schedule } : {}),
    ...(row.confidence != null ? { confidence: row.confidence as Observation["confidence"] } : {}),
    ...(row.is_forecast != null ? { isForecast: row.is_forecast } : {}),
    ...(row.related_ids ? { relatedIds: row.related_ids } : {}),
    // Evidence lifecycle is a crowd-only concept: feed rows are authoritative and
    // never go through evidence resolution (their routing_eligible column is
    // false/NULL and must NOT be asserted). Projecting these only for crowd rows
    // keeps feed-row output byte-identical and lets the Valhalla routing gate read
    // routingEligible on the crowd rows it actually consults.
    ...(row.origin?.kind === "crowd"
      ? {
          ...(row.evidence_state != null
            ? { evidenceState: row.evidence_state as Observation["evidenceState"] }
            : {}),
          routingEligible: row.routing_eligible ?? false,
        }
      : {}),
  };
  const specific =
    row.kind === "measurement"
      ? {
          metric: row.metric ?? "",
          value: row.value ?? undefined,
          level: row.level ?? undefined,
          unit: row.unit ?? undefined,
          aggregation: (row.aggregation ?? "live") as Measurement["aggregation"],
        }
      : {
          type: row.type ?? "other",
          subtype: row.subtype ?? undefined,
          category: (row.category ?? "conditions") as ConditionEvent["category"],
          severity: (row.severity ?? "unknown") as ConditionEvent["severity"],
          // NULL -> "derived" is safe only under the conjunct discriminator
          // (type==='congestion' AND severitySource==='derived'); severitySource
          // alone is stamped by nearly every severity-derivation path and must
          // never be read as a sensor-tier signal on its own.
          severitySource: (row.severity_source ?? "derived") as ConditionEvent["severitySource"],
          headline: row.headline ?? "",
          description: row.description ?? undefined,
        };
  // Domain-specific fields (roads/roadState/direction/isPlanned/lanesAffected, …)
  // live in `attributes`; spread them back onto the reconstructed model.
  return { ...base, ...specific, ...(row.attributes ?? {}) } as Observation;
}

/**
 * Reads observations within a bounding box as the canonical `Observation[]`
 * model (the inverse of the ingest write), for emitters that project from the
 * model (TraFF, GeoJSON, JSON-LD). Same domain/bbox/type/severity + validity
 * filters as {@link observationsByBbox}.
 */
export async function readObservations(
  db: QueryRunner,
  opts: Omit<ObservationsByBboxOpts, "domain"> & { domain?: string }
): Promise<Observation[]> {
  const { domain, bbox, types, minSeverity } = opts;
  const [west, south, east, north] = bbox;

  // The GTFS-RT alerts export reads across ALL domains (a road-domain event can
  // carry transit selectors), so `domain` is optional here; the emitter's
  // selector gate decides what belongs in the feed. Every other caller passes a
  // domain and gets the same single-domain filter as before.
  const params: unknown[] = [west, south, east, north];
  const clauses = [
    "o.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)",
    "o.status = 'active'",
    "(o.valid_to IS NULL OR o.valid_to > now())",
    "(o.expires_at IS NULL OR o.expires_at > now())",
  ];
  if (domain != null) {
    params.push(domain);
    clauses.push(`o.domain = $${params.length}`);
  }
  if (Array.isArray(types) && types.length > 0) {
    params.push(types);
    clauses.push(`o.type = ANY($${params.length}::text[])`);
  }
  if (minSeverity != null) {
    params.push(severityRank(minSeverity));
    clauses.push(`${SEVERITY_RANK_SQL} >= $${params.length}`);
  }

  const query = `
    SELECT
      o.id, o.source, o.source_format, o.domain, o.kind, o.type, o.subtype, o.category,
      o.severity, o.severity_source, o.headline, o.description, o.label,
      o.metric, o.value, o.level, o.unit, o.aggregation,
      o.status, o.valid_from, o.valid_to, o.data_updated_at, o.fetched_at, o.expires_at,
      o.schedule, o.confidence, o.is_forecast, o.related_ids,
      o.attributes, o.subject, o.informed, o.origin,
      o.evidence_state, o.routing_eligible,
      ST_AsGeoJSON(o.geom) AS geojson,
      ${IS_STALE_SQL} AS is_stale
    FROM conditions.observations o
    LEFT JOIN conditions.source_status ss ON ss.source = o.source
    WHERE ${clauses.join(" AND ")}
    ORDER BY ${SEVERITY_RANK_SQL} DESC
    LIMIT 2000`;

  const rows = (await db.execute<ObservationRow[]>(query, params)) ?? [];
  const observations = rows.map(rowToObservation);
  return opts.dedupe === false ? observations : dedupeAcrossSources(observations);
}
