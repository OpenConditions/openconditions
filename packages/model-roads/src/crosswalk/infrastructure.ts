/**
 * DATEX II `vmsType` → sign feature classification, keyed `vmsType:<value>`
 * for both versions. Graphic and full-matrix panels show free text and
 * images (`matrix`); a simple matrix sign shows a limited set of aspects such
 * as speed roundels and warning symbols, and prism and roller-blind signs
 * switch between fixed faces (`pictogram`). None of the types says a sign
 * stands over a lane, so none maps to `lane_control`.
 */
export const DATEX2_VMS_TYPES: Readonly<Record<string, string | null>> = {
  "vmsType:colourGraphic": "vms.matrix",
  "vmsType:monochromeGraphic": "vms.matrix",
  "vmsType:fullMatrixSign": "vms.matrix",
  "vmsType:matrixSign": "vms.pictogram",
  "vmsType:simpleMatrixSign": "vms.pictogram",
  "vmsType:continuousSign": "vms.pictogram",
  "vmsType:rotatingPrismSign": "vms.pictogram",
  "vmsType:rollerBlindSign": "vms.pictogram",
  "vmsType:virtualVms": "vms.other",
  "vmsType:other": "vms.other",
  "vmsType:_extended": null,
};

/** DATEX II 3.x `WorkingStatusEnum` (a sign's `workingStatus`) → `vms_working_status`. */
export const DATEX2_VMS_WORKING_STATUSES: Readonly<Record<string, string | null>> = {
  working: "in_service",
  notWorking: "fault",
  blank: "blank",
  covered: "out_of_service",
  _extended: null,
};

/** DATEX II 3.x `DeviceHealthEnum` → `device_status`. */
export const DATEX2_DEVICE_HEALTH: Readonly<Record<string, string | null>> = {
  ok: "ok",
  functionalityPartlyOk: "warning",
  intermittentlyOk: "warning",
  notOk: "error",
  alarm: "error",
  notResponding: "offline",
  offline: "offline",
  unknown: "unknown",
  _extended: null,
};

/**
 * DATEX II `TrafficStatusEnum` (both versions) → `los`. Version 2 has no
 * `slow`/`queuing` split: `congested` is queuing, `impossible` (traffic at a
 * standstill that makes driving impossible) is blocked, as the flow parsers
 * read it. An unspecified abnormal status says nothing about the level.
 */
export const DATEX2_TRAFFIC_STATUSES: Readonly<Record<string, string | null>> = {
  freeFlow: "free_flow",
  slow: "slow",
  heavy: "heavy",
  queuing: "queuing",
  congested: "queuing",
  stationary: "stationary",
  impossible: "blocked",
  unknown: "unknown",
  unspecifiedAbnormal: null,
  other: null,
  _extended: null,
};

/**
 * DATEX II traffic measured values → properties, keyed `<BasicData
 * class>/<path>` (a class key covers every value of the class). Minimum and
 * maximum speeds are `traffic.speed` observations with that aggregation;
 * density (vehicles per km), headways, gaps, axle and PCU flows, expected
 * values and annual statistics have no property yet; per-vehicle records
 * are never kept. A travel time is observed on its travel-time route: the
 * free-flow time and speed are the observation's baseline, the trend its
 * `quality.trend`, and the delay is derivable from the two.
 */
export const DATEX2_MEASURED_TRAFFIC: Readonly<Record<string, string | null>> = {
  IndividualVehicleDataValues: null,
  "TrafficSpeed/averageVehicleSpeed": "traffic.speed",
  "TrafficSpeed/minimumSpeed": "traffic.speed",
  "TrafficSpeed/maximumSpeed": "traffic.speed",
  "TrafficSpeed/normallyExpectedSpeed": null,
  "TrafficSpeed/speedPercentile/speedPercentile": null,
  "TrafficSpeed/speedPercentile/vehiclePercentage": null,
  "TrafficFlow/vehicleFlow": "traffic.volume",
  "TrafficFlow/axleFlow": null,
  "TrafficFlow/pcuFlow": null,
  "TrafficFlow/percentageLongVehicles": null,
  "TrafficFlow/normallyExpectedFlow": null,
  "TrafficFlow/annualAverageDailyTraffic": null,
  "TrafficFlow/monthlyAverageDailyTraffic": null,
  "TrafficFlow/axleCharacteristics/maximumWeight": null,
  "TrafficFlow/axleCharacteristics/minimumWeight": null,
  "TrafficConcentration/occupancy": "traffic.occupancy",
  "TrafficConcentration/density": null,
  "TrafficConcentration/concentration": null,
  "TrafficStatus/trafficStatus": "traffic.los",
  "TrafficStatus/trafficTrendType": null,
  TrafficGap: null,
  TrafficHeadway: null,
  "TravelTimeData/travelTime": "traffic.travel_time",
  "TravelTimeData/freeFlowTravelTime": null,
  "TravelTimeData/freeFlowSpeed": null,
  "TravelTimeData/normallyExpectedTravelTime": null,
  "TravelTimeData/travelTimeDelay": null,
  "TravelTimeData/travelTimeTrendType": null,
  "TravelTimeData/travelTimeType": null,
  "TravelTimeData/vehicleType": null,
};

/**
 * DATEX II `TravelTimeTrendTypeEnum` → `trend`, keyed by the element it
 * comes from: a parking occupancy that is "increasing" is filling, a travel
 * time that is "increasing" is rising, and one crosswalk cannot hold both
 * under the bare word.
 */
export const DATEX2_TRAVEL_TIME_TRENDS: Readonly<Record<string, string | null>> = {
  "travelTimeTrendType:increasing": "rising",
  "travelTimeTrendType:decreasing": "falling",
  "travelTimeTrendType:stable": "steady",
  "travelTimeTrendType:_extended": null,
};

export const DATEX2_TRAVEL_TIME_TRENDS_OUT: Readonly<Record<string, string | null>> = {
  rising: "travelTimeTrendType:increasing",
  falling: "travelTimeTrendType:decreasing",
  steady: "travelTimeTrendType:stable",
  filling: null,
  clearing: null,
};

/**
 * WZDx 4.x `FieldDeviceType` → feature classification, keyed
 * `device_type:<value>`. Location markers and traffic signals are not
 * features OpenConditions registers.
 */
export const WZDX_DEVICE_TYPES: Readonly<Record<string, string | null>> = {
  "device_type:arrow-board": "vms.arrow_board",
  "device_type:dynamic-message-sign": "vms.matrix",
  "device_type:hybrid-sign": "vms.hybrid",
  "device_type:flashing-beacon": "vms.flashing_beacon",
  "device_type:camera": "camera.traffic",
  "device_type:traffic-sensor": "measurement_site.traffic",
  "device_type:location-marker": null,
  "device_type:traffic-signal": null,
};

/** WZDx 4.x `FieldDeviceStatus` → `device_status`. */
export const WZDX_DEVICE_STATUSES: Readonly<Record<string, string | null>> = {
  ok: "ok",
  warning: "warning",
  error: "error",
  unknown: "unknown",
};
