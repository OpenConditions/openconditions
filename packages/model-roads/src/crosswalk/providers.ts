/**
 * Provider event vocabularies → roads classification, for the formats with no
 * standard vocabulary behind them. These are plain tables rather than registry
 * crosswalks: no emitter writes these vocabularies, and a provider token says
 * too little to round-trip. A token maps only to what it states; `null` marks
 * a known token that names no nature (the parser's coarse class applies).
 */

/**
 * Fintraffic Digitraffic traffic messages: `situationType`, then the
 * `trafficAnnouncementType` of a traffic announcement, both in the v1
 * upper-snake form (v2 `road work` normalises to `ROAD_WORK`). A road work is
 * refined by its phases' work types, keyed `ROAD_WORK:<workType>`.
 */
export const DIGITRAFFIC_SITUATIONS: Readonly<Record<string, string | null>> = {
  ROAD_WORK: "roadworks.works",
  WEIGHT_RESTRICTION: "restriction.dimension.weight",
  EXEMPTED_TRANSPORT: "incident.vehicle_hazard.abnormal_load",
  TRAFFIC_ANNOUNCEMENT: null,
  ACCIDENT_REPORT: "incident.accident",
  PRELIMINARY_ACCIDENT_REPORT: "incident.accident",
  GENERAL: null,
  UNCONFIRMED_OBSERVATION: null,
  "ROAD_WORK:MAINTENANCE": "roadworks.works.maintenance",
  "ROAD_WORK:ROAD_CONSTRUCTION": "roadworks.works.construction",
  "ROAD_WORK:RESURFACING": "roadworks.works.resurfacing",
  "ROAD_WORK:BRIDGE": "roadworks.works.bridge_work",
  "ROAD_WORK:CRASH_BARRIER": "roadworks.works.barrier_work",
  "ROAD_WORK:BURIED_CABLES": "roadworks.works.utility_work",
  "ROAD_WORK:ROAD_SURFACE_MARKING": "roadworks.works.line_marking",
  "ROAD_WORK:OTHER": null,
};

/** Singapore LTA DataMall `TrafficIncidents` `Type`, lower-cased. */
export const LTA_SITUATIONS: Readonly<Record<string, string | null>> = {
  accident: "incident.accident",
  roadwork: "roadworks.works",
  "vehicle breakdown": "incident.breakdown.disabled_vehicle",
  "unattended vehicle": "incident.breakdown.abandoned_vehicle",
  "heavy traffic": "congestion.congestion.heavy",
  obstacle: "incident.obstruction",
  "road block": "closure.closure",
  diversion: null,
  "reverse flow": null,
  flooding: "road_hazard.hazard.flooding",
  weather: "weather_condition.weather",
  fire: "incident.fire",
  "plant failure": "equipment_fault.fault",
  "plant/animal hazards": null,
  "misc.": null,
  miscellaneous: null,
};

/**
 * Poland GDDKiA `utrdane.xml`: the `typ` letter (U works, W accident, I other)
 * and the `awaria_mostu` bridge-failure flag, which outranks it. The
 * `droga_zamknieta` closure flag is an effect, never a nature.
 */
export const GDDKIA_SITUATIONS: Readonly<Record<string, string | null>> = {
  U: "roadworks.works",
  W: "incident.accident",
  I: null,
  awaria_mostu: "incident.obstruction.infrastructure_damage",
};

/** Sweden Trafikverket Situation `Deviation.MessageType`, lower-cased. */
export const TRAFIKVERKET_SITUATIONS: Readonly<Record<string, string | null>> = {
  olycka: "incident.accident",
  vägarbete: "roadworks.works",
  hinder: "incident.obstruction",
  avstängning: "closure.closure",
  "avstängd väg": "closure.closure.full",
  restriktion: null,
  vägförhållande: null,
  trafikmeddelande: null,
  "viktig trafikinformation": null,
  färjor: null,
};

/**
 * Autobahn GmbH API: an item's `display_type`, and for a traffic-flow item
 * its `abnormalTrafficType`, keyed `congestion:<abnormalTrafficType>`.
 */
export const AUTOBAHN_SITUATIONS: Readonly<Record<string, string | null>> = {
  ROADWORKS: "roadworks.works",
  SHORT_TERM_ROADWORKS: "roadworks.works",
  CLOSURE: "closure.closure",
  CLOSURE_ENTRY_EXIT: "closure.closure.ramp",
  WEIGHT_LIMIT_35: "restriction.dimension.weight",
  WARNING: null,
  congestion: "congestion.congestion",
  "congestion:STATIONARY_TRAFFIC": "congestion.congestion.stationary",
  "congestion:QUEUING_TRAFFIC": "congestion.congestion.queuing",
  "congestion:SLOW_TRAFFIC": "congestion.congestion.slow",
  "congestion:HEAVY_TRAFFIC": "congestion.congestion.heavy",
};

/**
 * Ohio OHGO `/incidents` `category`, lower-cased; a `/construction` work zone
 * is `construction`, refined by its category as `construction:<category>`.
 */
export const OHGO_SITUATIONS: Readonly<Record<string, string | null>> = {
  crash: "incident.accident",
  accident: "incident.accident",
  "vehicle crash": "incident.accident",
  "disabled vehicle": "incident.breakdown.disabled_vehicle",
  "vehicle fire": "incident.fire.vehicle_fire",
  debris: "incident.obstruction.debris",
  "road debris": "incident.obstruction.debris",
  hazard: "road_hazard.hazard",
  flooding: "road_hazard.hazard.flooding",
  weather: "weather_condition.weather",
  "police activity": "authority.operation.police_activity",
  closure: "closure.closure",
  "road closure": "closure.closure",
  construction: "roadworks.works",
  "construction:bridge work": "roadworks.works.bridge_work",
};

/**
 * Transport Victoria planned and unplanned disruptions: event subtype, event
 * type, then impact type or status, lower-cased. `incident` and `fire` name
 * no nature on their own (a fire may be a vehicle's or a bushfire).
 */
export const VIC_SITUATIONS: Readonly<Record<string, string | null>> = {
  roadworks: "roadworks.works",
  "road works": "roadworks.works",
  maintenance: "roadworks.works.maintenance",
  construction: "roadworks.works.construction",
  "special event": "public_event.event",
  event: "public_event.event",
  crash: "incident.accident",
  accident: "incident.accident",
  collision: "incident.accident",
  incident: null,
  hazard: "road_hazard.hazard",
  "traffic hazard": "road_hazard.hazard",
  "fallen tree": "incident.obstruction.fallen_tree",
  flooding: "road_hazard.hazard.flooding",
  weather: "weather_condition.weather",
  fire: null,
  closure: "closure.closure",
  "road closure": "closure.closure",
  congestion: "congestion.congestion",
};
