/**
 * Open511 events → roads classification. Open511's `event_subtypes` are one
 * flat list, independent of `event_type`, so both are keyed by their bare
 * value (the two lists share no value); a subtype is looked up first.
 */
export const OPEN511_SITUATIONS: Readonly<Record<string, string | null>> = {
  CONSTRUCTION: "roadworks.works",
  SPECIAL_EVENT: "public_event.event",
  INCIDENT: "incident.accident",
  WEATHER_CONDITION: "weather_condition.weather",
  ROAD_CONDITION: "road_condition.surface",
  ACCIDENT: "incident.accident",
  SPILL: "incident.obstruction.spill",
  OBSTRUCTION: "incident.obstruction",
  HAZARD: "road_hazard.hazard",
  ROAD_MAINTENANCE: "roadworks.works.maintenance",
  ROAD_CONSTRUCTION: "roadworks.works.construction",
  EMERGENCY_MAINTENANCE: "roadworks.works.emergency_repair",
  PLANNED_EVENT: null,
  CROWD: null,
  HAIL: "weather_condition.weather.hail",
  THUNDERSTORM: "weather_condition.weather.thunderstorm",
  HEAVY_DOWNPOUR: "weather_condition.weather.heavy_rain",
  STRONG_WINDS: "weather_condition.weather.high_wind",
  BLOWING_DUST: "weather_condition.weather.dust",
  SANDSTORM: "weather_condition.weather.dust",
  INSECT_SWARMS: null,
  AVALANCHE_HAZARD: "road_hazard.hazard.avalanche_risk",
  SURFACE_WATER_HAZARD: "road_condition.surface.standing_water",
  MUD: "road_condition.surface.mud",
  LOOSE_GRAVEL: "road_condition.surface.gravel",
  OIL_ON_ROADWAY: "road_condition.surface.oil",
  FIRE: "incident.fire",
  SIGNAL_LIGHT_FAILURE: "equipment_fault.fault.traffic_signal",
  PARTLY_ICY: "road_condition.surface.icy",
  ICE_COVERED: "road_condition.surface.icy",
  PARTLY_SNOW_PACKED: "road_condition.surface.snow_covered",
  SNOW_PACKED: "road_condition.surface.snow_covered",
  PARTLY_SNOW_COVERED: "road_condition.surface.snow_covered",
  SNOW_COVERED: "road_condition.surface.snow_covered",
  DRIFTING_SNOW: "road_condition.surface.snow_covered",
  POOR_VISIBILITY: "weather_condition.weather.reduced_visibility",
  ALMOST_IMPASSABLE: "road_condition.driving_condition.hazardous",
  PASSABLE_WITH_CARE: "road_condition.driving_condition.fair",
};

/** Open511 `severity` → the kernel severity label. */
export const OPEN511_SEVERITIES: Readonly<Record<string, string | null>> = {
  MINOR: "minor",
  MODERATE: "moderate",
  MAJOR: "major",
  UNKNOWN: "unknown",
};

/** Open511 `certainty` → the kernel certainty. */
export const OPEN511_CERTAINTIES: Readonly<Record<string, string | null>> = {
  OBSERVED: "observed",
  LIKELY: "likely",
  POSSIBLE: "possible",
  UNKNOWN: "unknown",
};
