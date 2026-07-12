import type { Feature, FeatureCollection } from "geojson";
import type {
  RoadConditionEvent,
  RoadConditionRoadRef,
  RoadConditionSchedule,
  RoadConditionSeverity,
  RoadConditionType,
  RoadState,
} from "./types.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Provenance kind for the event, so the host can gate routing + label the
 * overlay. The `observationsByBbox` projection flattens it onto
 * `properties.originKind`; we also read `properties.origin.kind` defensively in
 * case a caller passes the raw `origin` object instead.
 */
function originKindOf(p: Record<string, unknown>): "feed" | "crowd" | undefined {
  const flat = str(p.originKind);
  const nested = str((p.origin as { kind?: unknown } | undefined)?.kind);
  const kind = flat ?? nested;
  return kind === "feed" || kind === "crowd" ? kind : undefined;
}

/**
 * Maps one `observationsByBbox` GeoJSON feature to a `RoadConditionEvent`. Road
 * specifics (roads, roadState) live in the feature's `attributes` payload; the
 * `provider` field is left empty for the orchestrator to stamp.
 */
export function featureToRoadConditionEvent(feature: Feature): RoadConditionEvent | null {
  const p = (feature.properties ?? {}) as Record<string, unknown>;
  const id = str(p.id);
  if (!feature.geometry || !id) return null;

  const attrs = (p.attributes ?? {}) as Record<string, unknown>;

  return {
    id,
    source: str(p.source) ?? "",
    provider: "",
    type: (str(p.type) ?? "other") as RoadConditionType,
    severity: (str(p.severity) ?? "unknown") as RoadConditionSeverity,
    geometry: feature.geometry,
    headline: str(p.headline) ?? "",
    description: str(p.description),
    roadState: attrs.roadState as RoadState | undefined,
    roads: attrs.roads as RoadConditionRoadRef[] | undefined,
    validFrom:
      (p.valid_from as string | null | undefined) ??
      (attrs.validFrom as string | null | undefined) ??
      null,
    validTo: (p.valid_to as string | null | undefined) ?? null,
    ...(Array.isArray(p.schedule) && p.schedule.length > 0
      ? { schedule: p.schedule as RoadConditionSchedule[] }
      : {}),
    dataUpdatedAt: str(p.data_updated_at),
    attribution: p.attribution as RoadConditionEvent["attribution"],
    // Evidence provenance drives the host's routing gate + overlay labeling.
    // A feed observation → originKind "feed" and (from the projection) null
    // evidence fields, so it always routes. A crowd observation → originKind
    // "crowd" carrying its real routingEligible/evidenceState, so a lone
    // self-report never becomes a routing exclusion.
    originKind: originKindOf(p),
    ...(typeof p.routingEligible === "boolean" ? { routingEligible: p.routingEligible } : {}),
    ...(str(p.evidenceState) ? { evidenceState: str(p.evidenceState) } : {}),
    ...(typeof p.confidenceScore === "number" ? { confidenceScore: p.confidenceScore } : {}),
  };
}

export function featureCollectionToRoadConditionEvents(
  fc: FeatureCollection
): RoadConditionEvent[] {
  return fc.features
    .map(featureToRoadConditionEvent)
    .filter((e): e is RoadConditionEvent => e !== null);
}
