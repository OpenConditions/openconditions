/**
 * DATEX II infrastructure vocabularies, verbatim from the official schemas:
 * 3.7 `DATEXII_3_Vms.xsd`, `DATEXII_3_FaultAndStatus.xsd`, `DATEXII_3_RoadTrafficData.xsd`
 * (https://docs.datex2.eu/_static/data/v3.7/) and 2.3 `DATEXIISchema_2_2_3.xsd`
 * (https://docs.datex2.eu/_static/data/v2.3/DATEXIISchema_2_2_3_0.zip). `measuredValues`
 * lists, per concrete BasicData class, the paths of its measured values below the
 * class (a `…Value` element or an enumeration); an empty list is a class whose
 * values are per-vehicle records rather than site measurements.
 */
export const DATEX2_V3_INFRASTRUCTURE = {
  version: "3.7",
  vmsTypes: [
    "colourGraphic",
    "rotatingPrismSign",
    "monochromeGraphic",
    "simpleMatrixSign",
    "fullMatrixSign",
    "rollerBlindSign",
    "virtualVms",
    "other",
    "_extended",
  ],
  workingStatuses: ["blank", "covered", "notWorking", "working", "_extended"],
  deviceHealth: [
    "ok",
    "notOk",
    "functionalityPartlyOk",
    "intermittentlyOk",
    "alarm",
    "notResponding",
    "offline",
    "unknown",
    "_extended",
  ],
  trafficStatuses: [
    "stationary",
    "queuing",
    "slow",
    "heavy",
    "unspecifiedAbnormal",
    "freeFlow",
    "unknown",
    "other",
    "_extended",
  ],
  measuredValues: {
    IndividualVehicleDataValues: [],
    TrafficConcentration: ["density", "occupancy"],
    TrafficFlow: [
      "axleFlow",
      "pcuFlow",
      "percentageLongVehicles",
      "vehicleFlow",
      "normallyExpectedFlow",
      "annualAverageDailyTraffic",
      "monthlyAverageDailyTraffic",
      "axleCharacteristics/maximumWeight",
      "axleCharacteristics/minimumWeight",
    ],
    TrafficGap: ["averageDistanceGap", "averageTimeGap"],
    TrafficHeadway: ["averageDistanceHeadway", "averageTimeHeadway"],
    TrafficSpeed: [
      "averageVehicleSpeed",
      "speedPercentile/vehiclePercentage",
      "speedPercentile/speedPercentile",
      "normallyExpectedSpeed",
      "minimumSpeed",
      "maximumSpeed",
    ],
    TrafficStatus: ["trafficTrendType", "trafficStatus"],
    TravelTimeData: [
      "travelTimeTrendType",
      "travelTimeType",
      "vehicleType",
      "travelTime",
      "freeFlowTravelTime",
      "normallyExpectedTravelTime",
      "travelTimeDelay",
      "freeFlowSpeed",
    ],
  },
} as const;

export const DATEX2_V2_INFRASTRUCTURE = {
  version: "2.3",
  vmsTypes: ["colourGraphic", "continuousSign", "monochromeGraphic", "matrixSign", "other"],
  trafficStatuses: ["impossible", "congested", "heavy", "freeFlow", "unknown"],
  measuredValues: {
    IndividualVehicleDataValues: [],
    TrafficConcentration: ["concentration", "occupancy"],
    TrafficFlow: ["axleFlow", "pcuFlow", "percentageLongVehicles", "vehicleFlow"],
    TrafficHeadway: ["averageDistanceHeadway", "averageTimeHeadway"],
    TrafficSpeed: [
      "averageVehicleSpeed",
      "speedPercentile/vehiclePercentage",
      "speedPercentile/speedPercentile",
    ],
    TrafficStatus: ["trafficTrendType", "trafficStatus"],
    TravelTimeData: [
      "travelTimeTrendType",
      "travelTimeType",
      "vehicleType",
      "travelTime",
      "freeFlowTravelTime",
      "normallyExpectedTravelTime",
      "freeFlowSpeed",
    ],
  },
} as const;
