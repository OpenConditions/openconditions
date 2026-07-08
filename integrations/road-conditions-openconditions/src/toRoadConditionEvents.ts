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
  };
}

export function featureCollectionToRoadConditionEvents(
  fc: FeatureCollection
): RoadConditionEvent[] {
  return fc.features
    .map(featureToRoadConditionEvent)
    .filter((e): e is RoadConditionEvent => e !== null);
}
