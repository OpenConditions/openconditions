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

/** Vehicle classes a restriction applies to; a road-domain field, so it rides in `attributes`. */
function vehiclesAffectedOf(attrs: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(attrs.vehiclesAffected)) return undefined;
  const classes = attrs.vehiclesAffected.filter((v): v is string => typeof v === "string");
  return classes.length > 0 ? classes : undefined;
}

/**
 * Graph-binding outcome, when the instance has bound the event. Only
 * `exact`/`likely` are routing-relevant; `ambiguous` is carried for map/QA.
 */
function bindingOf(p: Record<string, unknown>): RoadConditionEvent["binding"] | undefined {
  const b = p.binding as Record<string, unknown> | undefined;
  const status = str(b?.status);
  if (!status) return undefined;
  const directionMode = str(b?.directionMode);
  return {
    status: status as NonNullable<RoadConditionEvent["binding"]>["status"],
    ...(typeof b?.confidence === "number" ? { confidence: b.confidence } : {}),
    ...(directionMode
      ? {
          directionMode: directionMode as NonNullable<
            RoadConditionEvent["binding"]
          >["directionMode"],
        }
      : {}),
  };
}

/** The ordered directed way spans the event occupies; the internal segment id is dropped. */
function segmentsOf(p: Record<string, unknown>): RoadConditionEvent["segments"] | undefined {
  if (!Array.isArray(p.segments)) return undefined;
  const spans = p.segments
    .map((s) => s as Record<string, unknown>)
    .filter(
      (s) =>
        typeof s?.wayId === "number" &&
        (s.dir === "f" || s.dir === "b") &&
        typeof s.startFraction === "number" &&
        typeof s.endFraction === "number"
    )
    .map((s) => ({
      wayId: s.wayId as number,
      dir: s.dir as "f" | "b",
      startFraction: s.startFraction as number,
      endFraction: s.endFraction as number,
    }));
  return spans.length > 0 ? spans : undefined;
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
  const delay = Number(attrs.delaySeconds);
  const groupId = str(attrs.situationId);
  const vehiclesAffected = vehiclesAffectedOf(attrs);
  const binding = bindingOf(p);
  const segments = segmentsOf(p);

  return {
    id,
    source: str(p.source) ?? "",
    provider: "",
    ...(groupId ? { groupId } : {}),
    type: (str(p.type) ?? "other") as RoadConditionType,
    severity: (str(p.severity) ?? "unknown") as RoadConditionSeverity,
    geometry: feature.geometry,
    headline: str(p.headline) ?? "",
    description: str(p.description),
    ...(Number.isFinite(delay) ? { delaySeconds: delay } : {}),
    ...(typeof attrs.speedLimitKph === "number" &&
    Number.isFinite(attrs.speedLimitKph) &&
    attrs.speedLimitKph > 0
      ? { speedLimitKph: attrs.speedLimitKph }
      : {}),
    ...(typeof p.is_stale === "boolean" ? { isStale: p.is_stale } : {}),
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
    // Planned-works labeling: the overlay dims and dashes works that have not
    // started yet. `is_forecast` is the upstream announcement flag; `isPlanned`
    // rides in `attributes` because it is a road-domain field.
    ...(typeof p.is_forecast === "boolean" ? { isForecast: p.is_forecast } : {}),
    ...(typeof attrs.isPlanned === "boolean" ? { isPlanned: attrs.isPlanned } : {}),
    ...(vehiclesAffected ? { vehiclesAffected } : {}),
    ...(binding ? { binding } : {}),
    ...(segments ? { segments } : {}),
  };
}

export function featureCollectionToRoadConditionEvents(
  fc: FeatureCollection
): RoadConditionEvent[] {
  return fc.features
    .map(featureToRoadConditionEvent)
    .filter((e): e is RoadConditionEvent => e !== null);
}
