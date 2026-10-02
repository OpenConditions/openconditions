import type { RoadClassification } from "@openconditions/model-roads";
import type { RoadEvent, RoadEventType } from "../model.js";

/**
 * The classification of a parser's coarse road-event type, for parsers whose
 * source has no standard vocabulary (provider feeds, the generic GeoJSON
 * mapping). The former types that were really effects (`lane_closure`,
 * `road_closure`, `speed_restriction`, `dimension_restriction`, `contraflow`,
 * `detour`) become the situation whose nature they describe; the effect
 * itself comes from the event's impact fields.
 */
export const ROAD_EVENT_TYPE_CLASSES: Readonly<Record<RoadEventType, RoadClassification>> = {
  accident: { kind: "incident", type: "accident" },
  congestion: { kind: "congestion", type: "congestion" },
  roadworks: { kind: "roadworks", type: "works" },
  lane_closure: { kind: "closure", type: "closure", subtype: "lane" },
  road_closure: { kind: "closure", type: "closure", subtype: "full" },
  contraflow: { kind: "other", type: "other" },
  detour: { kind: "closure", type: "closure" },
  hazard: { kind: "road_hazard", type: "hazard" },
  weather: { kind: "weather_condition", type: "weather" },
  road_condition: { kind: "road_condition", type: "surface" },
  obstruction: { kind: "incident", type: "obstruction" },
  broken_down_vehicle: { kind: "incident", type: "breakdown", subtype: "disabled_vehicle" },
  public_event: { kind: "public_event", type: "event" },
  authority: { kind: "authority", type: "operation" },
  speed_restriction: { kind: "restriction", type: "speed", subtype: "temporary" },
  dimension_restriction: { kind: "restriction", type: "dimension" },
  equipment_fault: { kind: "equipment_fault", type: "fault" },
  security: { kind: "security", type: "incident" },
  transit_disruption: { kind: "other", type: "other" },
  other: { kind: "other", type: "other" },
};

/** The event's classification: the parser's crosswalk result, else its coarse type's. */
export function classificationOf(event: RoadEvent): RoadClassification {
  return event.situation?.classification ?? ROAD_EVENT_TYPE_CLASSES[event.type];
}

/** A parse-local coarse road-event type with the category and planning it implies. */
export interface CoarseType {
  type: RoadEventType;
  category: RoadEvent["category"];
  isPlanned: boolean;
}

const PLANNED_TYPES = new Set<RoadEventType>(["roadworks", "public_event"]);
const INCIDENT_TYPES = new Set<RoadEventType>([
  "accident",
  "road_closure",
  "lane_closure",
  "contraflow",
  "broken_down_vehicle",
  "obstruction",
  "authority",
  "security",
  "transit_disruption",
]);

/** A coarse type with its category: works and events are planned, disruptions incidents. */
export function coarseType(type: RoadEventType): CoarseType {
  if (PLANNED_TYPES.has(type)) return { type, category: "planned", isPlanned: true };
  if (INCIDENT_TYPES.has(type)) return { type, category: "incident", isPlanned: false };
  return { type, category: "conditions", isPlanned: false };
}

const KIND_TYPES: Readonly<Record<string, RoadEventType>> = {
  "incident.accident": "accident",
  "incident.breakdown": "broken_down_vehicle",
  "incident.vehicle_hazard": "obstruction",
  "incident.obstruction": "obstruction",
  "incident.fire": "hazard",
  "roadworks.works": "roadworks",
  "restriction.speed": "speed_restriction",
  "restriction.dimension": "dimension_restriction",
  "restriction.access": "dimension_restriction",
  "restriction.seasonal_load": "dimension_restriction",
  "weather_condition.weather": "weather",
  "road_condition.surface": "road_condition",
  "road_condition.driving_condition": "road_condition",
  "road_hazard.hazard": "hazard",
  "public_event.event": "public_event",
  "authority.operation": "authority",
  "equipment_fault.fault": "equipment_fault",
  "security.incident": "security",
  "winter_operation.chain_control": "road_condition",
  "pass_status.pass": "road_condition",
  "congestion.congestion": "congestion",
};

/**
 * The coarse type a classification reads as, the inverse direction of
 * {@link ROAD_EVENT_TYPE_CLASSES}: a lane closure is `lane_closure`, any other
 * closure `road_closure`; no classification, or one without a coarse
 * counterpart, is `other`.
 */
export function coarseOf(c: RoadClassification | undefined): CoarseType {
  if (c === undefined) return coarseType("other");
  if (c.kind === "closure")
    return coarseType(c.subtype === "lane" ? "lane_closure" : "road_closure");
  return coarseType(KIND_TYPES[`${c.kind}.${c.type}`] ?? "other");
}
