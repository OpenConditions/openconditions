/**
 * Waze / Google Closure and Incident Feed Specification (CIFS) v2 vocabulary,
 * from `https://www.gstatic.com/road-incidents/cifsv2.xsd` and
 * `https://developers.google.com/waze/data-feed/cifs-specification`.
 *
 * The XSD enumerations are held directly against the pinned schema in
 * `@openconditions/roads`'s `cifs-conformance.test.ts`. Two subtypes published
 * in the web documentation (`HAZARD_ON_ROAD_EMERGENCY_VEHICLE` and
 * `POLICE_WITH_MOBILE_CAMERA`) are absent from `cifsv2.xsd`: inbound parsing
 * accepts them, while outbound emission writes only XSD-valid subtypes.
 */

export const CIFS_TYPES = [
  "ACCIDENT",
  "CONSTRUCTION",
  "HAZARD",
  "ROAD_CLOSED",
  "POLICE",
  "CHIT_CHAT",
  "JAM",
] as const;

export type CifsType = (typeof CIFS_TYPES)[number];

/** The 36 non-empty subtypes enumerated by `cifsv2.xsd`. */
export const CIFS_XSD_SUBTYPES = [
  "ACCIDENT_MAJOR",
  "ACCIDENT_MINOR",
  "HAZARD_ON_ROAD",
  "HAZARD_ON_ROAD_CAR_STOPPED",
  "HAZARD_ON_ROAD_CONSTRUCTION",
  "HAZARD_ON_ROAD_ICE",
  "HAZARD_ON_ROAD_LANE_CLOSED",
  "HAZARD_ON_ROAD_OBJECT",
  "HAZARD_ON_ROAD_OIL",
  "HAZARD_ON_ROAD_POT_HOLE",
  "HAZARD_ON_ROAD_ROAD_KILL",
  "HAZARD_ON_ROAD_TRAFFIC_LIGHT_FAULT",
  "HAZARD_ON_SHOULDER",
  "HAZARD_ON_SHOULDER_ANIMALS",
  "HAZARD_ON_SHOULDER_CAR_STOPPED",
  "HAZARD_ON_SHOULDER_MISSING_SIGN",
  "HAZARD_WEATHER",
  "HAZARD_WEATHER_FLOOD",
  "HAZARD_WEATHER_FOG",
  "HAZARD_WEATHER_FREEZING_RAIN",
  "HAZARD_WEATHER_HAIL",
  "HAZARD_WEATHER_HEAT_WAVE",
  "HAZARD_WEATHER_HEAVY_RAIN",
  "HAZARD_WEATHER_HEAVY_SNOW",
  "HAZARD_WEATHER_HURRICANE",
  "HAZARD_WEATHER_MONSOON",
  "HAZARD_WEATHER_TORNADO",
  "JAM_HEAVY_TRAFFIC",
  "JAM_LIGHT_TRAFFIC",
  "JAM_MODERATE_TRAFFIC",
  "JAM_STAND_STILL_TRAFFIC",
  "ROAD_CLOSED_CONSTRUCTION",
  "ROAD_CLOSED_EVENT",
  "ROAD_CLOSED_HAZARD",
  "POLICE_VISIBLE",
  "POLICE_HIDING",
] as const;

export type CifsXsdSubtype = (typeof CIFS_XSD_SUBTYPES)[number];

/** Subtypes documented on Google Developers but omitted from `cifsv2.xsd`. */
export const CIFS_DOC_ONLY_SUBTYPES = [
  "HAZARD_ON_ROAD_EMERGENCY_VEHICLE",
  "POLICE_WITH_MOBILE_CAMERA",
] as const;

export type CifsDocOnlySubtype = (typeof CIFS_DOC_ONLY_SUBTYPES)[number];

/** Every non-empty CIFS subtype accepted on inbound parsing (38 values). */
export const CIFS_SUBTYPES = [...CIFS_XSD_SUBTYPES, ...CIFS_DOC_ONLY_SUBTYPES] as const;
export type CifsSubtype = (typeof CIFS_SUBTYPES)[number];

export const CIFS_DIRECTIONS = ["ONE_DIRECTION", "BOTH_DIRECTIONS"] as const;
export type CifsDirection = (typeof CIFS_DIRECTIONS)[number];

export const CIFS_ROADSIDES = ["LEFT", "MIDDLE", "RIGHT"] as const;
export type CifsRoadside = (typeof CIFS_ROADSIDES)[number];

export const CIFS_LANE_STATUSES = [
  "OPEN_LANE",
  "OPEN",
  "OPENED",
  "CLOSED_LANE",
  "CLOSE",
  "CLOSED",
] as const;
export type CifsLaneStatus = (typeof CIFS_LANE_STATUSES)[number];

/** Legal `(type, subtype)` pairings per Waze's CIFS specification. */
export const CIFS_SUBTYPES_BY_TYPE: Readonly<Record<CifsType, readonly CifsSubtype[]>> = {
  ACCIDENT: ["ACCIDENT_MAJOR", "ACCIDENT_MINOR"],
  CONSTRUCTION: [],
  HAZARD: [
    "HAZARD_ON_ROAD",
    "HAZARD_ON_ROAD_CAR_STOPPED",
    "HAZARD_ON_ROAD_CONSTRUCTION",
    "HAZARD_ON_ROAD_EMERGENCY_VEHICLE",
    "HAZARD_ON_ROAD_ICE",
    "HAZARD_ON_ROAD_LANE_CLOSED",
    "HAZARD_ON_ROAD_OBJECT",
    "HAZARD_ON_ROAD_OIL",
    "HAZARD_ON_ROAD_POT_HOLE",
    "HAZARD_ON_ROAD_ROAD_KILL",
    "HAZARD_ON_ROAD_TRAFFIC_LIGHT_FAULT",
    "HAZARD_ON_SHOULDER",
    "HAZARD_ON_SHOULDER_ANIMALS",
    "HAZARD_ON_SHOULDER_CAR_STOPPED",
    "HAZARD_ON_SHOULDER_MISSING_SIGN",
    "HAZARD_WEATHER",
    "HAZARD_WEATHER_FLOOD",
    "HAZARD_WEATHER_FOG",
    "HAZARD_WEATHER_FREEZING_RAIN",
    "HAZARD_WEATHER_HAIL",
    "HAZARD_WEATHER_HEAT_WAVE",
    "HAZARD_WEATHER_HEAVY_RAIN",
    "HAZARD_WEATHER_HEAVY_SNOW",
    "HAZARD_WEATHER_HURRICANE",
    "HAZARD_WEATHER_MONSOON",
    "HAZARD_WEATHER_TORNADO",
  ],
  ROAD_CLOSED: ["ROAD_CLOSED_CONSTRUCTION", "ROAD_CLOSED_EVENT", "ROAD_CLOSED_HAZARD"],
  POLICE: ["POLICE_VISIBLE", "POLICE_HIDING", "POLICE_WITH_MOBILE_CAMERA"],
  CHIT_CHAT: [],
  JAM: [
    "JAM_LIGHT_TRAFFIC",
    "JAM_MODERATE_TRAFFIC",
    "JAM_HEAVY_TRAFFIC",
    "JAM_STAND_STILL_TRAFFIC",
  ],
};

export const CIFS = {
  types: CIFS_TYPES,
  xsdSubtypes: CIFS_XSD_SUBTYPES,
  docOnlySubtypes: CIFS_DOC_ONLY_SUBTYPES,
  subtypes: CIFS_SUBTYPES,
  directions: CIFS_DIRECTIONS,
  roadsides: CIFS_ROADSIDES,
  laneStatuses: CIFS_LANE_STATUSES,
  subtypesByType: CIFS_SUBTYPES_BY_TYPE,
} as const;
