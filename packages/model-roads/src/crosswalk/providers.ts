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

/**
 * Castle Rock CARS events (the TMDD-based 511 APIs, 511NY among them): the
 * phrase codes of an event's descriptions, lower-cased, and the headline
 * category as `category:<category>` when no phrase names a nature. The phrase
 * list is the one 511NY's migration guide publishes, with the codes its live
 * feed also writes. A winter road condition is read by its own rule, not here.
 */
export const CARS_SITUATIONS: Readonly<Record<string, string | null>> = {
  closed: "closure.closure",
  "road closed": "closure.closure",
  "drawbridge up": "closure.closure.bridge",
  roadwork: "roadworks.works",
  "planned roadwork": "roadworks.works",
  "nighttime roadwork": "roadworks.works",
  "road construction": "roadworks.works.construction",
  "long term road construction": "roadworks.works.construction",
  "road reconstruction": "roadworks.works.construction",
  "road maintenance operations": "roadworks.works.maintenance",
  "crack sealing operations": "roadworks.works.maintenance",
  "traffic signal maintenance work": "roadworks.works.maintenance",
  "tunnel maintenance": "roadworks.works.maintenance",
  "paving operations": "roadworks.works.resurfacing",
  "bridge maintenance operations": "roadworks.works.bridge_work",
  "bridge demolition work": "roadworks.works.demolition",
  "utility work": "roadworks.works.utility_work",
  "gas main work": "roadworks.works.utility_work",
  "water main work": "roadworks.works.utility_work",
  "emergency repairs": "roadworks.works.emergency_repair",
  "emergency maintenance": "roadworks.works.emergency_repair",
  "roadside mowing": "roadworks.works.roadside_work",
  "lane shift": "roadworks.works",
  "lane shifts": "roadworks.works",
  "lane shifting": "roadworks.works",
  "slow moving maintenance vehicle": "incident.vehicle_hazard.maintenance_vehicle",
  crash: "incident.accident",
  "earlier accident": "incident.accident",
  "air crash": "incident.accident",
  "multi vehicle crash": "incident.accident.multi_vehicle",
  "jackknifed trailer": "incident.accident.jackknifed_truck",
  "overturned vehicle": "incident.accident.overturned",
  "overturned truck": "incident.accident.overturned",
  "overturned semi trailer": "incident.accident.overturned",
  "vehicle spun out": "incident.accident",
  "disabled vehicle": "incident.breakdown.disabled_vehicle",
  "disabled truck": "incident.breakdown.disabled_vehicle",
  "disabled bus": "incident.breakdown.disabled_vehicle",
  "disabled semi trailer": "incident.breakdown.disabled_vehicle",
  "abandoned vehicle": "incident.breakdown.abandoned_vehicle",
  "vehicle fire": "incident.fire.vehicle_fire",
  "building fire": "incident.fire.roadside_fire",
  "serious fire": "incident.fire",
  "brush fire": "road_hazard.hazard.wildfire_near_road",
  "forest fire": "road_hazard.hazard.wildfire_near_road",
  "debris on roadway": "incident.obstruction.debris",
  "obstruction on roadway": "incident.obstruction.object",
  "spilled load": "incident.obstruction.spill",
  "fuel spill": "incident.obstruction.spill",
  "animal on roadway": "incident.obstruction.animal",
  pothole: "incident.obstruction.pothole",
  "road surface collapse": "incident.obstruction.sinkhole",
  "collapsed sewer": "incident.obstruction.sinkhole",
  "downed power lines": "incident.obstruction.infrastructure_damage",
  "storm damage": "incident.obstruction.infrastructure_damage",
  "earthquake damage": "incident.obstruction.infrastructure_damage",
  landslide: "incident.obstruction.landslide",
  "rough road": "road_condition.surface.rough",
  flooding: "road_hazard.hazard.flooding",
  "broken water main": "road_hazard.hazard.flooding",
  "heavy snow": "weather_condition.weather.snow",
  hurricane: "weather_condition.weather.storm",
  "adverse weather": "weather_condition.weather",
  "traffic congestion": "congestion.congestion",
  "heavy traffic": "congestion.congestion.heavy",
  "holiday traffic": "congestion.congestion.heavy",
  "stop and go traffic": "congestion.congestion.stop_and_go",
  delays: "congestion.congestion",
  "wide load": "incident.vehicle_hazard.oversize_vehicle",
  "prohibited vehicle on roadway": "incident.vehicle_hazard.prohibited_vehicle",
  "emergency vehicles": "authority.operation.emergency_services",
  "crash investigation work": "authority.operation.police_activity",
  "customs point open": "authority.operation.customs",
  "traffic lights not working": "equipment_fault.fault.traffic_signal",
  "traffic signal flashing red": "equipment_fault.fault.traffic_signal",
  "power failure": "equipment_fault.fault.power",
  "equipment failure": "equipment_fault.fault",
  "truck restriction": "restriction.access.truck_ban",
  "no commercial trailer traffic": "restriction.access.truck_ban",
  "no trailers": "restriction.access.truck_ban",
  "speed restriction": "restriction.speed.temporary",
  restrictions: null,
  concert: "public_event.event.concert",
  parade: "public_event.event.parade",
  festival: "public_event.event.festival",
  fair: "public_event.event.festival",
  "outdoor market": "public_event.event.market",
  show: "public_event.event.exhibition",
  "trade expo": "public_event.event.exhibition",
  demonstration: "public_event.event.demonstration",
  "funeral procession": "public_event.event.procession",
  "vip visit": "public_event.event.state_visit",
  "special event": "public_event.event",
  "sports event": "public_event.event.sporting",
  "baseball game": "public_event.event.sporting",
  "basketball game": "public_event.event.sporting",
  "boxing match": "public_event.event.sporting",
  "football game": "public_event.event.sporting",
  "golf tournament": "public_event.event.sporting",
  "hockey game": "public_event.event.sporting",
  "soccer game": "public_event.event.sporting",
  "tennis tournament": "public_event.event.sporting",
  "race event": "public_event.event.sporting",
  "bicycle race": "public_event.event.sporting",
  marathon: "public_event.event.sporting",
  rodeo: "public_event.event.sporting",
  incident: null,
  "traffic incident": null,
  "amber alert": null,
  "silver alert": null,
  "test message": null,
  "traffic signals repaired": null,
  "category:closure": "closure.closure",
  "category:roadwork": "roadworks.works",
  "category:construction": "roadworks.works",
  "category:incident": null,
  "category:obstruction": "incident.obstruction",
  "category:restriction": null,
  "category:special-event": "public_event.event",
  "category:sporting-event": "public_event.event.sporting",
  "category:device-status": "equipment_fault.fault",
};
