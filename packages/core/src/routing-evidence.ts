export type GrantState = "yes" | "no" | "unknown";

export type CanonicalVehicleClass =
  "motor_vehicle" | "car" | "truck" | "bus" | "motorcycle" | "bicycle" | "pedestrian";

export interface RoutingApplicability {
  kind: "all" | "classes" | "unknown";
  classes?: CanonicalVehicleClass[];
  raw?: string[];
}

export interface RoutingRights {
  source_redistribution: GrantState;
  derived_redistribution: GrantState;
  commercial_use: GrantState;
  attribution_required: GrantState;
  retention: GrantState;
  evidence_origin: string | null;
  evidence_version: string | null;
  reviewed_at: string | null;
}

export interface RoutingEvidenceSegment {
  segment_id: string;
  direction: "forward" | "reverse";
  from_fraction: number;
  to_fraction: number;
}

export type RoutingBindingStatus =
  | "exact"
  | "likely"
  | "ambiguous"
  | "unresolved"
  | "no_coverage"
  | "unattempted"
  | "obsolete"
  | "invalid"
  | "not_applicable";

/** Versioned evidence OC gives routing consumers with each projected event. */
export interface RoadConditionRoutingEvidence {
  schema_version: 1;
  observation_revision: string;
  /** Revision of the observation snapshot the binding resolved. */
  binding_revision: string;
  graph_generation: string;
  resolver_version: string;
  source_id: string;
  child_source_id: string | null;
  source_license: string;
  license_url: string | null;
  attribution: string | null;
  record_url: string | null;
  source_checked_at: string;
  fresh_until: string;
  expires_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  next_transition_at: string | null;
  direction_mode: "forward" | "reverse" | "both" | "unknown";
  applicability: RoutingApplicability;
  rights: RoutingRights;
  segments: RoutingEvidenceSegment[];
  binding_status: RoutingBindingStatus;
  reason_codes: string[];
  evaluated_at: string;
}

function finiteInstant(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Fail-closed reasons common to every OC routing projection. Temporal activity
 * is evaluated separately at travel time; this checks the evidence authority
 * at `evaluatedAt` and the structural completeness of the binding.
 */
export function routingEvidenceReasons(
  evidence: RoadConditionRoutingEvidence,
  evaluatedAt: Date
): string[] {
  const reasons: string[] = [];
  const now = evaluatedAt.getTime();
  if (evidence.schema_version !== 1) reasons.push("schema_version_unsupported");
  for (const [field, value] of [
    ["observation_revision", evidence.observation_revision],
    ["binding_revision", evidence.binding_revision],
    ["graph_generation", evidence.graph_generation],
    ["resolver_version", evidence.resolver_version],
    ["source_id", evidence.source_id],
    ["source_license", evidence.source_license],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "") reasons.push(`${field}_missing`);
  }
  if (evidence.observation_revision !== evidence.binding_revision) {
    reasons.push("binding_revision_mismatch");
  }
  if (evidence.binding_status !== "exact" && evidence.binding_status !== "likely") {
    reasons.push(`binding_${evidence.binding_status}`);
  }
  if (finiteInstant(evidence.source_checked_at) == null) reasons.push("source_check_invalid");
  if (finiteInstant(evidence.evaluated_at) == null) reasons.push("evaluated_at_invalid");
  const freshUntil = finiteInstant(evidence.fresh_until);
  if (freshUntil == null) reasons.push("freshness_deadline_invalid");
  else if (Number.isFinite(now) && now >= freshUntil) reasons.push("source_stale");
  const expiresAt = evidence.expires_at == null ? null : finiteInstant(evidence.expires_at);
  if (evidence.expires_at != null && expiresAt == null) reasons.push("expires_at_invalid");
  else if (expiresAt != null && Number.isFinite(now) && now >= expiresAt) {
    reasons.push("observation_expired");
  }
  for (const [field, value] of [
    ["valid_from", evidence.valid_from],
    ["valid_to", evidence.valid_to],
    ["next_transition", evidence.next_transition_at],
  ] as const) {
    if (value != null && finiteInstant(value) == null) reasons.push(`${field}_invalid`);
  }

  for (const grant of [
    "source_redistribution",
    "derived_redistribution",
    "commercial_use",
    "retention",
  ] as const) {
    if (evidence.rights[grant] !== "yes") {
      reasons.push(`rights_${grant}_${evidence.rights[grant]}`);
    }
  }
  if (evidence.rights.reviewed_at != null && finiteInstant(evidence.rights.reviewed_at) == null) {
    reasons.push("rights_reviewed_at_invalid");
  }
  if (evidence.applicability.kind === "unknown") reasons.push("applicability_unknown");
  if (
    evidence.applicability.kind === "classes" &&
    (!evidence.applicability.classes || evidence.applicability.classes.length === 0)
  ) {
    reasons.push("applicability_empty");
  }
  if (evidence.direction_mode === "unknown") reasons.push("direction_unknown");
  if (evidence.segments.length === 0) reasons.push("segments_unresolved");
  else if (
    evidence.segments.some(
      (span) =>
        span.segment_id.length === 0 ||
        !Number.isFinite(span.from_fraction) ||
        !Number.isFinite(span.to_fraction) ||
        span.from_fraction < 0 ||
        span.to_fraction > 1 ||
        span.from_fraction > span.to_fraction
    )
  ) {
    reasons.push("invalid_segment_span");
  }
  const segmentDirections = new Set(evidence.segments.map((span) => span.direction));
  if (
    (evidence.direction_mode === "forward" &&
      (segmentDirections.size !== 1 || !segmentDirections.has("forward"))) ||
    (evidence.direction_mode === "reverse" &&
      (segmentDirections.size !== 1 || !segmentDirections.has("reverse"))) ||
    (evidence.direction_mode === "both" &&
      (!segmentDirections.has("forward") || !segmentDirections.has("reverse")))
  ) {
    reasons.push("segment_direction_mismatch");
  }
  if (evidence.reason_codes.length > 0) reasons.push("evidence_reported_unapplied");
  return reasons;
}
