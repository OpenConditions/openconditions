import { BINDING_JOIN_SQL, BINDING_SELECT_SQL } from "./observation-query.js";
import type { Geometry } from "geojson";
import { dedupeAcrossSources } from "./crossSourceDedupe.js";
import type {
  BindingStatus,
  ConditionEvent,
  DirectionMode,
  Measurement,
  Observation,
  Provenance,
  SegmentSpan,
} from "./model.js";
import type { QueryRunner } from "./observationsByBbox.js";
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
  instance_id?: string | null;
  canonical_id?: string | null;
  phenomenon_fingerprint?: string | null;
  replaces?: string[] | null;
  corroborations?: string[] | null;
  fuzziness?: Observation["fuzziness"] | null;
  confidence_score?: number | null;
  severity_level?: number | null;
  privacy_class?: Observation["privacyClass"] | null;
  k_anonymity?: number | null;
  dp_epsilon?: number | null;
  dp_delta?: number | null;
  source_uri?: string | null;
  source_license?: string | null;
  // Only selected when `includeBindings` is set; absent otherwise.
  binding_status?: BindingStatus | null;
  binding_confidence?: number | null;
  binding_direction_mode?: DirectionMode | null;
  segments?: SegmentSpan[] | null;
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
    ...(row.instance_id != null ? { instanceId: row.instance_id } : {}),
    ...(row.canonical_id != null ? { canonicalId: row.canonical_id } : {}),
    ...(row.phenomenon_fingerprint != null
      ? { phenomenonFingerprint: row.phenomenon_fingerprint }
      : {}),
    ...(row.replaces != null ? { replaces: row.replaces } : {}),
    ...(row.corroborations != null ? { corroborations: row.corroborations } : {}),
    ...(row.fuzziness != null ? { fuzziness: row.fuzziness } : {}),
    ...(row.confidence_score != null ? { confidenceScore: row.confidence_score } : {}),
    ...(row.privacy_class != null ? { privacyClass: row.privacy_class } : {}),
    ...(row.k_anonymity != null ? { kAnonymity: row.k_anonymity } : {}),
    ...(row.dp_epsilon != null ? { dpEpsilon: row.dp_epsilon } : {}),
    ...(row.dp_delta != null ? { dpDelta: row.dp_delta } : {}),
    ...(row.source_uri != null ? { sourceUri: row.source_uri } : {}),
    ...(row.source_license != null ? { sourceLicense: row.source_license } : {}),
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
    // Derived graph binding, present only when the read asked for it (the
    // columns are absent from the default query, so this never fires there).
    ...(row.binding_status
      ? {
          binding: {
            status: row.binding_status,
            ...(row.binding_confidence != null ? { confidence: row.binding_confidence } : {}),
            ...(row.binding_direction_mode ? { directionMode: row.binding_direction_mode } : {}),
          },
        }
      : {}),
    ...(row.segments && row.segments.length > 0 ? { segments: row.segments } : {}),
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
          ...(row.severity_level != null ? { severityLevel: row.severity_level } : {}),
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
  return { ...(row.attributes ?? {}), ...base, ...specific } as Observation;
}

/** A bounded display read, or an explicitly complete routing read. */
export interface ReadObservationsOptions {
  domain?: string;
  bbox: [number, number, number, number];
  types?: string[];
  minSeverity?: string;
  kind?: string;
  horizonDays?: number;
  dedupe?: boolean;
  requireComplete?: boolean;
  routingEligibleOnly?: boolean;
  includeBindings?: boolean;
  excludedSourceIds?: string[];
}

const OBSERVATION_SELECT_SQL = `
  o.id, o.source, o.source_format, o.domain, o.kind, o.type, o.subtype, o.category,
  o.severity, o.severity_source, o.headline, o.description, o.label,
  o.metric, o.value, o.level, o.unit, o.aggregation,
  o.status, o.valid_from, o.valid_to, o.data_updated_at, o.fetched_at, o.expires_at,
  o.schedule, o.confidence, o.is_forecast, o.related_ids,
  o.attributes, o.subject, o.informed, o.origin,
  o.evidence_state, o.routing_eligible,
  o.instance_id, o.canonical_id, o.phenomenon_fingerprint, o.replaces, o.corroborations,
  o.fuzziness, o.confidence_score, o.severity_level, o.privacy_class,
  o.k_anonymity, o.dp_epsilon, o.dp_delta, o.source_uri, o.source_license,
  ST_AsGeoJSON(o.geom) AS geojson`;

export async function readObservations(
  db: QueryRunner,
  opts: ReadObservationsOptions
): Promise<Observation[]> {
  const { domain, bbox, types, minSeverity, horizonDays } = opts;
  const [west, south, east, north] = bbox;
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
  if (opts.kind != null) {
    params.push(opts.kind);
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
  if (horizonDays != null) {
    params.push(horizonDays);
    clauses.push(
      `(o.valid_from IS NULL OR o.valid_from <= now() + make_interval(days => $${params.length}))`
    );
  }
  if (opts.excludedSourceIds?.length) {
    params.push(opts.excludedSourceIds);
    const p = `$${params.length}`;
    clauses.push(`o.source <> ALL(${p}::text[])`);
    clauses.push(
      `COALESCE(o.attributes->>'parentSourceId', o.origin#>>'{attribution,parentSourceId}', '') <> ALL(${p}::text[])`
    );
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        COALESCE(o.attributes->'policyIds', o.origin#>'{attribution,policyIds}', '[]'::jsonb)
      ) policy_id WHERE policy_id = ANY(${p}::text[]))`);
  }
  if (opts.routingEligibleOnly) {
    clauses.push(
      "NOT (o.origin->>'kind' = 'crowd' AND COALESCE(o.routing_eligible, false) IS NOT TRUE)"
    );
  }
  const bindingSelect = opts.includeBindings ? BINDING_SELECT_SQL : "";
  const bindingJoin = opts.includeBindings ? BINDING_JOIN_SQL : "";
  const query = `
    SELECT ${OBSERVATION_SELECT_SQL}, ${IS_STALE_SQL} AS is_stale${bindingSelect}
    FROM conditions.observations o
    LEFT JOIN conditions.source_status ss ON ss.source = o.source${bindingJoin}
    WHERE ${clauses.join(" AND ")}
    ORDER BY ${SEVERITY_RANK_SQL} DESC, o.id
    LIMIT ${opts.requireComplete ? 100001 : 2000}`;
  const result = await db.execute<ObservationRow[]>(query, params);
  if (opts.requireComplete && !Array.isArray(result)) {
    throw new Error("Complete observation query unavailable");
  }
  const rows = result ?? [];
  if (opts.requireComplete && rows.length > 100000) {
    throw new Error("Complete observation query exceeds routing limit");
  }
  const observations = rows.map(rowToObservation);
  return opts.requireComplete || opts.dedupe === false
    ? observations
    : dedupeAcrossSources(observations);
}

/** Complete keyset scan for exports. The caller must supply a repeatable-read
 * transaction so membership/content stay fixed across pages. No display dedupe:
 * every retained observation keeps its own source identity and provenance. */
export async function* scanObservations(
  db: QueryRunner,
  opts: { asOf: string; pageSize?: number }
): AsyncGenerator<Observation[], void> {
  const pageSize = opts.pageSize ?? 1000;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10000) {
    throw new RangeError("Observation scan page size must be an integer from 1 to 10000");
  }
  if (!Number.isFinite(Date.parse(opts.asOf)))
    throw new TypeError("Invalid observation scan cutoff");
  let after: string | null = null;
  for (;;) {
    const rows: ObservationRow[] = await db.execute<ObservationRow[]>(
      `
      SELECT ${OBSERVATION_SELECT_SQL}, ${IS_STALE_SQL} AS is_stale
      FROM conditions.observations o
      LEFT JOIN conditions.source_status ss ON ss.source = o.source
      WHERE o.status = 'active'
        AND (o.valid_to IS NULL OR o.valid_to > $1::timestamptz)
        AND (o.expires_at IS NULL OR o.expires_at > $1::timestamptz)
        AND ($2::text IS NULL OR o.id > $2::text)
      ORDER BY o.id
      LIMIT $3`,
      [opts.asOf, after, pageSize]
    );
    if (!Array.isArray(rows)) throw new Error("Complete observation scan unavailable");
    if (rows.length === 0) return;
    yield rows.map(rowToObservation);
    after = rows[rows.length - 1]!.id;
    if (rows.length < pageSize) return;
  }
}
