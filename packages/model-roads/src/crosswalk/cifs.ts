import {
  CIFS_SUBTYPES_BY_TYPE,
  type CifsSubtype,
  type CifsType,
  type CifsXsdSubtype,
} from "../vocabularies/cifs.js";

/**
 * CIFS `type` and `subtype` → roads situation classification. Every CIFS
 * subtype is globally unique across types and disjoint from the 7 top-level
 * types, so all 45 non-empty codes share one ingest mapping table. Callers
 * validate the `(type, subtype)` pair with {@link isValidCifsPair} before
 * lookup so mismatches such as `HAZARD` + `ROAD_CLOSED_EVENT` are rejected.
 *
 * `ROAD_CLOSED_*` records carry their cause classification here while the CIFS
 * parser separately sets `roadState: "closed"` so they gain a `closure` effect.
 * `CHIT_CHAT` is not a road condition and maps to `null`.
 */
export const CIFS_SITUATIONS: Readonly<Record<CifsType | CifsSubtype, string | null>> = {
  ACCIDENT: "incident.accident",
  ACCIDENT_MAJOR: "incident.accident",
  ACCIDENT_MINOR: "incident.accident",

  CONSTRUCTION: "roadworks.works",

  HAZARD: "road_hazard.hazard",
  HAZARD_ON_ROAD: "incident.obstruction",
  HAZARD_ON_ROAD_CAR_STOPPED: "incident.breakdown.disabled_vehicle",
  HAZARD_ON_ROAD_CONSTRUCTION: "roadworks.works.construction",
  HAZARD_ON_ROAD_EMERGENCY_VEHICLE: "incident.vehicle_hazard.emergency_vehicle",
  HAZARD_ON_ROAD_ICE: "road_condition.surface.icy",
  HAZARD_ON_ROAD_LANE_CLOSED: "closure.closure.lane",
  HAZARD_ON_ROAD_OBJECT: "incident.obstruction.object",
  HAZARD_ON_ROAD_OIL: "road_condition.surface.oil",
  HAZARD_ON_ROAD_POT_HOLE: "incident.obstruction.pothole",
  HAZARD_ON_ROAD_ROAD_KILL: "incident.obstruction.animal",
  HAZARD_ON_ROAD_TRAFFIC_LIGHT_FAULT: "equipment_fault.fault.traffic_signal",

  HAZARD_ON_SHOULDER: "road_hazard.hazard",
  HAZARD_ON_SHOULDER_ANIMALS: "road_hazard.hazard.wildlife",
  HAZARD_ON_SHOULDER_CAR_STOPPED: "incident.breakdown.disabled_vehicle",
  HAZARD_ON_SHOULDER_MISSING_SIGN: "equipment_fault.fault",

  HAZARD_WEATHER: "weather_condition.weather",
  HAZARD_WEATHER_FLOOD: "road_hazard.hazard.flooding",
  HAZARD_WEATHER_FOG: "weather_condition.weather.fog",
  HAZARD_WEATHER_FREEZING_RAIN: "weather_condition.weather.freezing_rain",
  HAZARD_WEATHER_HAIL: "weather_condition.weather.hail",
  HAZARD_WEATHER_HEAT_WAVE: "weather_condition.weather.extreme_heat",
  HAZARD_WEATHER_HEAVY_RAIN: "weather_condition.weather.heavy_rain",
  HAZARD_WEATHER_HEAVY_SNOW: "weather_condition.weather.snow",
  HAZARD_WEATHER_HURRICANE: "weather_condition.weather.storm",
  HAZARD_WEATHER_MONSOON: "weather_condition.weather.heavy_rain",
  HAZARD_WEATHER_TORNADO: "weather_condition.weather.storm",

  JAM: "congestion.congestion",
  JAM_LIGHT_TRAFFIC: "congestion.congestion.slow",
  JAM_MODERATE_TRAFFIC: "congestion.congestion.heavy",
  JAM_HEAVY_TRAFFIC: "congestion.congestion.queuing",
  JAM_STAND_STILL_TRAFFIC: "congestion.congestion.stationary",

  ROAD_CLOSED: "closure.closure.full",
  ROAD_CLOSED_CONSTRUCTION: "roadworks.works.construction",
  ROAD_CLOSED_EVENT: "public_event.event",
  ROAD_CLOSED_HAZARD: "road_hazard.hazard",

  POLICE: "authority.operation.police_activity",
  POLICE_VISIBLE: "authority.operation.police_activity",
  POLICE_HIDING: "authority.operation.police_activity",
  POLICE_WITH_MOBILE_CAMERA: "authority.operation.enforcement",

  CHIT_CHAT: null,
};

/** Outbound CIFS `(type, subtype)` pair, restricted to `cifsv2.xsd` values. */
export interface CifsIncidentCode {
  type: Exclude<CifsType, "CONSTRUCTION" | "CHIT_CHAT">;
  subtype?: CifsXsdSubtype;
}

/**
 * Roads classification → outbound CIFS non-closure incident code.
 *
 * This table is explicit export policy rather than a reverse lookup of
 * {@link CIFS_SITUATIONS}: it never writes deprecated top-level `CONSTRUCTION`,
 * `CHIT_CHAT`, or doc-only subtypes absent from `cifsv2.xsd`. Every registered
 * `kind.type` has an entry or an explicit `null`. Full road closures are
 * driven by verified `closure` effects in the emitter rather than by nature
 * alone, so `closure.closure` and `pass_status.pass` map to `null` here.
 */
export const CIFS_INCIDENTS: Readonly<Record<string, CifsIncidentCode | null>> = {
  "incident.accident": { type: "ACCIDENT" },
  "incident.breakdown": { type: "HAZARD", subtype: "HAZARD_ON_ROAD_CAR_STOPPED" },
  "incident.vehicle_hazard": { type: "HAZARD", subtype: "HAZARD_ON_ROAD" },
  "incident.obstruction": { type: "HAZARD", subtype: "HAZARD_ON_ROAD" },
  "incident.obstruction.object": { type: "HAZARD", subtype: "HAZARD_ON_ROAD_OBJECT" },
  "incident.obstruction.animal": { type: "HAZARD", subtype: "HAZARD_ON_ROAD_ROAD_KILL" },
  "incident.obstruction.pothole": { type: "HAZARD", subtype: "HAZARD_ON_ROAD_POT_HOLE" },
  "incident.obstruction.stranded_vehicle": {
    type: "HAZARD",
    subtype: "HAZARD_ON_ROAD_CAR_STOPPED",
  },
  "incident.fire": { type: "HAZARD", subtype: "HAZARD_ON_ROAD" },

  "roadworks.works": { type: "HAZARD", subtype: "HAZARD_ON_ROAD_CONSTRUCTION" },

  "closure.closure": null,
  "restriction.dimension": null,
  "restriction.access": null,
  "restriction.speed": null,
  "restriction.seasonal_load": null,
  "winter_operation.chain_control": null,

  "weather_condition.weather": { type: "HAZARD", subtype: "HAZARD_WEATHER" },
  "weather_condition.weather.fog": { type: "HAZARD", subtype: "HAZARD_WEATHER_FOG" },
  "weather_condition.weather.freezing_rain": {
    type: "HAZARD",
    subtype: "HAZARD_WEATHER_FREEZING_RAIN",
  },
  "weather_condition.weather.hail": { type: "HAZARD", subtype: "HAZARD_WEATHER_HAIL" },
  "weather_condition.weather.extreme_heat": {
    type: "HAZARD",
    subtype: "HAZARD_WEATHER_HEAT_WAVE",
  },
  "weather_condition.weather.heavy_rain": {
    type: "HAZARD",
    subtype: "HAZARD_WEATHER_HEAVY_RAIN",
  },
  "weather_condition.weather.snow": { type: "HAZARD", subtype: "HAZARD_WEATHER_HEAVY_SNOW" },
  "weather_condition.weather.blizzard": { type: "HAZARD", subtype: "HAZARD_WEATHER_HEAVY_SNOW" },
  "weather_condition.weather.storm": { type: "HAZARD", subtype: "HAZARD_WEATHER" },
  "weather_condition.weather.ice": { type: "HAZARD", subtype: "HAZARD_ON_ROAD_ICE" },
  "weather_condition.weather.black_ice": { type: "HAZARD", subtype: "HAZARD_ON_ROAD_ICE" },

  "road_condition.surface": { type: "HAZARD", subtype: "HAZARD_ON_ROAD" },
  "road_condition.surface.icy": { type: "HAZARD", subtype: "HAZARD_ON_ROAD_ICE" },
  "road_condition.surface.oil": { type: "HAZARD", subtype: "HAZARD_ON_ROAD_OIL" },
  "road_condition.surface.standing_water": { type: "HAZARD", subtype: "HAZARD_WEATHER_FLOOD" },
  "road_condition.driving_condition": { type: "HAZARD", subtype: "HAZARD_ON_ROAD" },

  "road_hazard.hazard": { type: "HAZARD", subtype: "HAZARD_ON_ROAD" },
  "road_hazard.hazard.flooding": { type: "HAZARD", subtype: "HAZARD_WEATHER_FLOOD" },
  "road_hazard.hazard.high_water": { type: "HAZARD", subtype: "HAZARD_WEATHER_FLOOD" },
  "road_hazard.hazard.wildlife": { type: "HAZARD", subtype: "HAZARD_ON_SHOULDER_ANIMALS" },

  "public_event.event": null,

  "authority.operation": null,
  "authority.operation.police_activity": { type: "POLICE" },
  "authority.operation.police_checkpoint": { type: "POLICE" },

  "equipment_fault.fault": null,
  "equipment_fault.fault.traffic_signal": {
    type: "HAZARD",
    subtype: "HAZARD_ON_ROAD_TRAFFIC_LIGHT_FAULT",
  },

  "security.incident": null,
  "pass_status.pass": null,

  "congestion.congestion": { type: "JAM" },
  "congestion.congestion.slow": { type: "JAM", subtype: "JAM_LIGHT_TRAFFIC" },
  "congestion.congestion.heavy": { type: "JAM", subtype: "JAM_MODERATE_TRAFFIC" },
  "congestion.congestion.queuing": { type: "JAM", subtype: "JAM_HEAVY_TRAFFIC" },
  "congestion.congestion.stop_and_go": { type: "JAM", subtype: "JAM_HEAVY_TRAFFIC" },
  "congestion.congestion.stationary": { type: "JAM", subtype: "JAM_STAND_STILL_TRAFFIC" },

  "other.other": null,
};

/** Whether `type` is a known CIFS `type` token. */
export function isCifsType(value: string): value is CifsType {
  return Object.hasOwn(CIFS_SUBTYPES_BY_TYPE, value);
}

/** Whether `(type, subtype)` is a legal pairing in Waze's CIFS specification. */
export function isValidCifsPair(type: string, subtype: string | undefined): boolean {
  if (!isCifsType(type)) return false;
  if (subtype === undefined || subtype === "") return true;
  return (CIFS_SUBTYPES_BY_TYPE[type] as readonly string[]).includes(subtype);
}

/** Outbound CIFS incident code for a situation classification (subtype first, then type). */
export function cifsIncidentCodeOf(c: {
  kind: string;
  type: string;
  subtype?: string;
}): CifsIncidentCode | null {
  if (c.subtype !== undefined) {
    const key = `${c.kind}.${c.type}.${c.subtype}`;
    if (Object.hasOwn(CIFS_INCIDENTS, key)) return CIFS_INCIDENTS[key] ?? null;
  }
  const base = `${c.kind}.${c.type}`;
  return Object.hasOwn(CIFS_INCIDENTS, base) ? (CIFS_INCIDENTS[base] ?? null) : null;
}
