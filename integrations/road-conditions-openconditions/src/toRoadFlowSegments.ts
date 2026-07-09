import type { Feature, FeatureCollection } from "geojson";
import type { RoadFlowSegment } from "./types.js";

const LOS_VALUES: readonly RoadFlowSegment["los"][] = [
  "free_flow",
  "heavy",
  "queuing",
  "stationary",
  "unknown",
];
const CONFIDENCE_VALUES: readonly RoadFlowSegment["confidence"][] = [
  "measured",
  "estimated",
  "typical",
  "unknown",
];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Coerce an upstream `los` value to the union, falling back to `"unknown"`
 * for anything absent or off-list (never trust an arbitrary upstream string). */
function los(v: unknown): RoadFlowSegment["los"] {
  const s = str(v);
  return s && (LOS_VALUES as readonly string[]).includes(s)
    ? (s as RoadFlowSegment["los"])
    : "unknown";
}

/** Coerce an upstream `confidence` value to the union, falling back to
 * `"typical"` for anything absent or off-list. */
function confidence(v: unknown): RoadFlowSegment["confidence"] {
  const s = str(v);
  return s && (CONFIDENCE_VALUES as readonly string[]).includes(s)
    ? (s as RoadFlowSegment["confidence"])
    : "typical";
}

/**
 * Maps one `/segments.geojson` feature (`packages/publishers` `segmentsToGeoJSON`,
 * OpenConditions repo) to a `RoadFlowSegment`. A base segment with no fused
 * speed yet arrives with no speed properties at all (the emitter omits null
 * fields rather than sending them as `null`) — that case maps to
 * `los: "unknown"`, `confidence: "typical"`; both fields are required on
 * `RoadFlowSegment`, so this is the single place that invents that default.
 */
export function featureToRoadFlowSegment(
  feature: Feature,
  providerId: string
): RoadFlowSegment | null {
  const p = (feature.properties ?? {}) as Record<string, unknown>;
  const id = str(p["segment_id"]);
  if (!feature.geometry || feature.geometry.type !== "LineString" || !id) return null;

  const direction = p["dir"] === "b" ? "b" : "f";

  return {
    id,
    geometry: feature.geometry,
    ...(num(p["current_kph"]) !== undefined ? { currentSpeedKph: num(p["current_kph"]) } : {}),
    ...(num(p["free_flow_kph"]) !== undefined ? { freeFlowSpeedKph: num(p["free_flow_kph"]) } : {}),
    ...(num(p["speed_ratio"]) !== undefined ? { speedRatio: num(p["speed_ratio"]) } : {}),
    los: los(p["los"]),
    confidence: confidence(p["confidence"]),
    direction,
    ...(str(p["ref"]) !== undefined ? { roads: str(p["ref"]) } : {}),
    source: providerId,
    ...(str(p["observed_at"]) !== undefined ? { observedAt: str(p["observed_at"]) } : {}),
  };
}

export function featureCollectionToRoadFlowSegments(
  fc: FeatureCollection,
  providerId: string
): RoadFlowSegment[] {
  return fc.features
    .map((f) => featureToRoadFlowSegment(f, providerId))
    .filter((s): s is RoadFlowSegment => s !== null);
}
