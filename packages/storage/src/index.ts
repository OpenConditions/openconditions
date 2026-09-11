// SPDX-License-Identifier: AGPL-3.0-or-later
// Extracted from services/ingest/src/pipeline/write-postgis.ts; original license retained.
import { createHash } from "node:crypto";
import { toIsoTimestamp, type Observation } from "@openconditions/core";

/**
 * Recursively sorts object keys (arrays keep their order) so `JSON.stringify`
 * is stable regardless of property insertion order — required so
 * {@link computeContentHash} never flips for the same logical content just
 * because a source re-serializes its fields in a different key order.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

interface ContentHashInput {
  id: string;
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
  geometry_json: string;
  subject: unknown;
  attributes: unknown;
  valid_from: string | null;
  valid_to: string | null;
  schedule: unknown;
  confidence: string | null;
  is_forecast: boolean;
  related_ids: unknown;
  data_updated_at: string;
  expires_at: string | null;
  // Commons content-bearing fields — hashed only WHEN PRESENT (see
  // computeContentHash). The derived/identity commons fields are intentionally
  // absent here: they never enter the hash.
  replaces: unknown;
  corroborations: unknown;
  fuzziness: string | null;
  severity_level: number | null;
  informed: unknown;
  source_uri: string | null;
  source_license: string | null;
  k_anonymity: number | null;
  dp_epsilon: number | null;
  dp_delta: number | null;
}

/**
 * Deterministic hash of everything that defines "the same observation
 * content". This is the diff key the swap upsert compares (`ON CONFLICT ...
 * WHERE content_hash IS DISTINCT FROM excluded.content_hash`) so an unchanged
 * row is never rewritten. Deliberately EXCLUDES provenance/freshness fields
 * that must never count as a content change on their own: source, domain,
 * origin, fetched_at, stale_after, is_stale. `expires_at` IS included: unlike
 * those, it is source-declared content (not derived at write time) and a hard
 * read filter + sweep-expiry boundary, so a source moving an observation's
 * expiry must count as a real change. Geometry is hashed as the GeoJSON
 * string (not the DB geom), so it stays independent of PostGIS's own
 * normalization.
 *
 * The commons content-bearing fields are folded in only WHEN PRESENT so an
 * observation carrying none of them hashes byte-identically to before those
 * columns existed — that absent-key omission is what keeps existing feeds from
 * mass-rewriting. The derived/identity commons fields (instance_id,
 * canonical_id, phenomenon_fingerprint, confidence_score, privacy_class) are
 * excluded entirely: they are derived from already-hashed content or trusted
 * writer config, so hashing them would force the same one-time full rewrite.
 */
function computeContentHash(row: ContentHashInput): string {
  const material: Record<string, unknown> = {
    id: row.id,
    type: row.type,
    subtype: row.subtype,
    category: row.category,
    severity: row.severity,
    severitySource: row.severity_source,
    headline: row.headline,
    description: row.description,
    label: row.label,
    metric: row.metric,
    value: row.value,
    level: row.level,
    unit: row.unit,
    aggregation: row.aggregation,
    status: row.status,
    geometry: row.geometry_json,
    subject: row.subject,
    attributes: row.attributes,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    schedule: row.schedule,
    confidence: row.confidence,
    isForecast: row.is_forecast,
    relatedIds: row.related_ids,
    dataUpdatedAt: row.data_updated_at,
    expiresAt: row.expires_at,
  };
  if (row.replaces != null) material.replaces = row.replaces;
  if (row.corroborations != null) material.corroborations = row.corroborations;
  if (row.fuzziness != null) material.fuzziness = row.fuzziness;
  if (row.severity_level != null) material.severityLevel = row.severity_level;
  if (row.informed != null) material.informed = row.informed;
  if (row.source_uri != null) material.sourceUri = row.source_uri;
  if (row.source_license != null) material.sourceLicense = row.source_license;
  if (row.k_anonymity != null) material.kAnonymity = row.k_anonymity;
  if (row.dp_epsilon != null) material.dpEpsilon = row.dp_epsilon;
  if (row.dp_delta != null) material.dpDelta = row.dp_delta;
  return createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(material)))
    .digest("hex");
}

/**
 * Maps a single Observation to the flat row object that the INSERT expects.
 * Geometry is handled inline via `ST_SetSRID(ST_GeomFromGeoJSON(...), 4326)`.
 * Domain attributes are supplied explicitly by the caller; this package owns no registry.
 */
export function toRow(obs: Observation, attributes: Record<string, unknown>) {
  const condEvent = obs as Observation & {
    type?: string;
    subtype?: string;
    category?: string;
    severity?: string;
    severitySource?: string;
    headline?: string;
    description?: string;
    severityLevel?: number;
  };
  // Measurement axis (e.g. RoadFlow) — populated when kind === "measurement".
  const measurement = obs as Observation & {
    metric?: string;
    value?: number;
    level?: string;
    unit?: string;
    aggregation?: string;
  };

  const row = {
    id: obs.id,
    source: obs.source,
    source_format: obs.sourceFormat,
    domain: obs.domain,
    kind: obs.kind,
    type: condEvent.type ?? null,
    subtype: condEvent.subtype ?? null,
    category: condEvent.category ?? null,
    severity: condEvent.severity ?? null,
    severity_source: condEvent.severitySource ?? null,
    headline: condEvent.headline ?? null,
    description: condEvent.description ?? null,
    label: obs.label ?? null,
    metric: measurement.metric ?? null,
    value: measurement.value ?? null,
    level: measurement.level ?? null,
    unit: measurement.unit ?? null,
    aggregation: measurement.aggregation ?? null,
    status: obs.status,
    geometry_json: JSON.stringify(obs.geometry),
    subject: obs.subject ? obs.subject : null,
    attributes: attributes,
    valid_from: toIsoTimestamp(obs.validFrom) ?? null,
    valid_to: toIsoTimestamp(obs.validTo) ?? null,
    schedule: obs.schedule ? obs.schedule : null,
    confidence: obs.confidence ?? null,
    is_forecast: obs.isForecast ?? false,
    related_ids: obs.relatedIds ? obs.relatedIds : null,
    origin: obs.origin,
    // data_updated_at / fetched_at are NOT NULL: coerce, falling back so a
    // malformed source timestamp degrades to a valid value instead of aborting
    // the whole batch insert.
    data_updated_at:
      toIsoTimestamp(obs.dataUpdatedAt) ??
      toIsoTimestamp(obs.fetchedAt) ??
      new Date().toISOString(),
    fetched_at: toIsoTimestamp(obs.fetchedAt) ?? new Date().toISOString(),
    expires_at: toIsoTimestamp(obs.expiresAt) ?? null,
    is_stale: obs.isStale ?? false,
    // Commons fields: pass-through only. `undefined` collapses to null (or the
    // column default for fuzziness/privacy_class); no derivation happens here.
    instance_id: obs.instanceId ?? null,
    canonical_id: obs.canonicalId ?? null,
    phenomenon_fingerprint: obs.phenomenonFingerprint ?? null,
    replaces: obs.replaces ?? null,
    corroborations: obs.corroborations ?? null,
    fuzziness: obs.fuzziness ?? null,
    confidence_score: obs.confidenceScore ?? null,
    // Derived evidence-policy outputs — pass-through only, EXCLUDED from
    // content_hash (recomputed on replay). A feed row never carries them.
    evidence_state: obs.evidenceState ?? null,
    routing_eligible: obs.routingEligible ?? false,
    severity_level: condEvent.severityLevel ?? null,
    privacy_class: obs.privacyClass ?? null,
    k_anonymity: obs.kAnonymity ?? null,
    dp_epsilon: obs.dpEpsilon ?? null,
    dp_delta: obs.dpDelta ?? null,
    informed: obs.informed ?? null,
    source_uri: obs.sourceUri ?? null,
    source_license: obs.sourceLicense ?? null,
  };

  return { ...row, content_hash: computeContentHash(row) };
}
