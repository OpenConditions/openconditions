import type { RoadEventType } from "./model.js";

export interface TypeMapping {
  type: RoadEventType;
  category: "incident" | "planned" | "conditions" | "report";
  isPlanned: boolean;
}

const FALLBACK: TypeMapping = { type: "other", category: "conditions", isPlanned: false };

/**
 * Cross-walk from normalized source-format class names to canonical RoadEventType.
 * Keys are lower-cased, namespace-stripped DATEX II class names.
 */
export const TYPE_CROSSWALK: Record<string, TypeMapping> = {
  accident: { type: "accident", category: "incident", isPlanned: false },
  vehicleobstruction: { type: "broken_down_vehicle", category: "incident", isPlanned: false },
  roadorcarriagewayorlanemanagement: { type: "lane_closure", category: "incident", isPlanned: false },
  reroutingmanagement: { type: "detour", category: "conditions", isPlanned: false },
  speedmanagement: { type: "speed_restriction", category: "conditions", isPlanned: false },
  generalobstruction: { type: "obstruction", category: "incident", isPlanned: false },
  maintenanceworks: { type: "roadworks", category: "planned", isPlanned: true },
  constructionworks: { type: "roadworks", category: "planned", isPlanned: true },
  generalnetworkmanagement: { type: "other", category: "conditions", isPlanned: false },
  roadclosure: { type: "road_closure", category: "incident", isPlanned: false },
  abnormaltraffic: { type: "congestion", category: "conditions", isPlanned: false },
  congestion: { type: "congestion", category: "conditions", isPlanned: false },
  hazard: { type: "hazard", category: "conditions", isPlanned: false },
  weatherrelated: { type: "weather", category: "conditions", isPlanned: false },
  poorenvironmentconditions: { type: "weather", category: "conditions", isPlanned: false },
  roadsurfaceconditions: { type: "road_condition", category: "conditions", isPlanned: false },
  publicevent: { type: "public_event", category: "planned", isPlanned: true },
  authority: { type: "authority", category: "incident", isPlanned: false },
  transitdisruption: { type: "transit_disruption", category: "incident", isPlanned: false },
  equipmentorsystemfault: { type: "equipment_fault", category: "conditions", isPlanned: false },
  securityincident: { type: "security", category: "incident", isPlanned: false },
  dimensionrestriction: { type: "dimension_restriction", category: "conditions", isPlanned: false },
  contraflow: { type: "contraflow", category: "conditions", isPlanned: false },
};

/**
 * Map a source-format class name to a canonical TypeMapping.
 * Tolerates namespace prefixes (e.g. "sit:Accident") and is case-insensitive.
 * Unknown types fall through to { type:"other", category:"conditions", isPlanned:false }.
 */
export function mapSourceType(
  _format: string,
  code: string,
): TypeMapping {
  const colonIdx = code.indexOf(":");
  const bare = colonIdx >= 0 ? code.slice(colonIdx + 1) : code;
  const key = bare.toLowerCase();
  return TYPE_CROSSWALK[key] ?? FALLBACK;
}
