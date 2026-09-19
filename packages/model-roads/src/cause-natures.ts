/**
 * The nature a situation takes from its stated cause when none of its source
 * records names a nature: DATEX publishers such as NDW report roadworks and
 * incidents as lane, speed and rerouting management records whose only
 * statement of what is going on is `cause/causeType` (`roadMaintenance`,
 * `accident`). The cause stays in `causes`; this only decides kind and type.
 * `null` marks a cause that names no nature (the situation stays `other`).
 */
export const CAUSE_NATURES: Readonly<Record<string, string | null>> = {
  accident: "incident.accident",
  breakdown: "incident.breakdown",
  debris: "incident.obstruction.debris",
  spill: "incident.obstruction.spill",
  fire: "incident.fire",
  police_activity: "authority.operation.police_activity",
  animal: "incident.obstruction.animal",
  congestion: "congestion.congestion",
  hazard: "road_hazard.hazard",
  weather: "weather_condition.weather",
  roadworks: "roadworks.works",
  maintenance: "roadworks.works.maintenance",
  construction: "roadworks.works.construction",
  public_event: "public_event.event",
  security: "security.incident",
  infrastructure_failure: "incident.obstruction.infrastructure_damage",
  equipment_failure: "equipment_fault.fault",
  flooding: "road_hazard.hazard.flooding",
  landslide: "incident.obstruction.landslide",
  avalanche: "road_hazard.hazard.avalanche_risk",
  wildfire: "road_hazard.hazard.wildfire_near_road",
  strike: "public_event.event.demonstration",
  demonstration: "public_event.event.demonstration",
  medical_emergency: "authority.operation.emergency_services",
  obstruction: "incident.obstruction",
  abnormal_load: "incident.vehicle_hazard.abnormal_load",
  military: "authority.operation.military_convoy",
  customs: "authority.operation.customs",
  unknown: null,
  other: null,
};
