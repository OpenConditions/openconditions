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
