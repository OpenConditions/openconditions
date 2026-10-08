import type { SourceTable, TargetTable } from "@openconditions/model";

/** OCPI 2.2.1 codes → OpenConditions values, and back for the OCPI-shaped read API. */

export const OCPI_EVSE_STATUSES: SourceTable = {
  AVAILABLE: "available",
  BLOCKED: "blocked",
  CHARGING: "charging",
  INOPERATIVE: "inoperative",
  OUTOFORDER: "out_of_order",
  PLANNED: "planned",
  REMOVED: "removed",
  RESERVED: "reserved",
  UNKNOWN: "unknown",
};

export const OCPI_EVSE_STATUSES_OUT: TargetTable = {
  available: "AVAILABLE",
  blocked: "BLOCKED",
  charging: "CHARGING",
  inoperative: "INOPERATIVE",
  out_of_order: "OUTOFORDER",
  planned: "PLANNED",
  removed: "REMOVED",
  reserved: "RESERVED",
  /** OCPI has no state for a car plugged in but not drawing power. */
  occupied: null,
  unknown: "UNKNOWN",
};

/**
 * Connector standards are OCPI's own list, so the crosswalk is the identity
 * plus OCPI 2.3's SAE_J3400.
 */
export const OCPI_CONNECTOR_STANDARDS: SourceTable = Object.fromEntries(
  [
    "CHADEMO",
    "CHAOJI",
    "DOMESTIC_A",
    "DOMESTIC_B",
    "DOMESTIC_C",
    "DOMESTIC_D",
    "DOMESTIC_E",
    "DOMESTIC_F",
    "DOMESTIC_G",
    "DOMESTIC_H",
    "DOMESTIC_I",
    "DOMESTIC_J",
    "DOMESTIC_K",
    "DOMESTIC_L",
    "DOMESTIC_M",
    "DOMESTIC_N",
    "DOMESTIC_O",
    "GBT_AC",
    "GBT_DC",
    "IEC_60309_2_single_16",
    "IEC_60309_2_three_16",
    "IEC_60309_2_three_32",
    "IEC_60309_2_three_64",
    "IEC_62196_T1",
    "IEC_62196_T1_COMBO",
    "IEC_62196_T2",
    "IEC_62196_T2_COMBO",
    "IEC_62196_T3A",
    "IEC_62196_T3C",
    "NEMA_5_20",
    "NEMA_6_30",
    "NEMA_6_50",
    "NEMA_10_30",
    "NEMA_10_50",
    "NEMA_14_30",
    "NEMA_14_50",
    "PANTOGRAPH_BOTTOM_UP",
    "PANTOGRAPH_TOP_DOWN",
    "TESLA_R",
    "TESLA_S",
    "SAE_J3400",
    "UNKNOWN",
  ].map((value) => [value, value]),
);

export const OCPI_CONNECTOR_STANDARDS_OUT: TargetTable = {
  ...Object.fromEntries(Object.keys(OCPI_CONNECTOR_STANDARDS).map((v) => [v, v])),
  /** OCPI 2.2.1 predates megawatt charging and has no code for it. */
  MCS: null,
};

/** OCPI tariff-restriction weekday names → the opening-hours day codes. */
export const OCPI_DAYS = {
  MONDAY: "MO",
  TUESDAY: "TU",
  WEDNESDAY: "WE",
  THURSDAY: "TH",
  FRIDAY: "FR",
  SATURDAY: "SA",
  SUNDAY: "SU",
} as const satisfies Record<string, string>;

/** OCPI facilities → the shared amenity vocabulary. */
export const OCPI_FACILITIES: SourceTable = {
  HOTEL: "hotel",
  RESTAURANT: "restaurant",
  CAFE: "cafe",
  MALL: "mall",
  SUPERMARKET: "supermarket",
  SPORT: "sport",
  RECREATION_AREA: "recreation_area",
  NATURE: "nature",
  MUSEUM: "museum",
  BIKE_SHARING: "bike_sharing",
  BUS_STOP: "bus_stop",
  TAXI_STAND: "taxi_stand",
  TRAM_STOP: "tram_stop",
  METRO_STATION: "metro_station",
  TRAIN_STATION: "train_station",
  AIRPORT: "airport",
  PARKING_LOT: "parking",
  CARPOOL_PARKING: "carpool_parking",
  FUEL_STATION: "petrol_station",
  WIFI: "wifi",
};

export const OCPI_FACILITIES_OUT: TargetTable = {
  hotel: "HOTEL",
  restaurant: "RESTAURANT",
  cafe: "CAFE",
  mall: "MALL",
  supermarket: "SUPERMARKET",
  sport: "SPORT",
  recreation_area: "RECREATION_AREA",
  nature: "NATURE",
  museum: "MUSEUM",
  bike_sharing: "BIKE_SHARING",
  bus_stop: "BUS_STOP",
  taxi_stand: "TAXI_STAND",
  tram_stop: "TRAM_STOP",
  metro_station: "METRO_STATION",
  train_station: "TRAIN_STATION",
  airport: "AIRPORT",
  parking: "PARKING_LOT",
  carpool_parking: "CARPOOL_PARKING",
  petrol_station: "FUEL_STATION",
  wifi: "WIFI",
};

/** OCPI tariff dimensions → the kernel's price component types. */
export const OCPI_TARIFF_DIMENSIONS: Readonly<Record<string, string>> = {
  ENERGY: "energy",
  FLAT: "flat",
  PARKING_TIME: "parking_time",
  TIME: "time",
};

/** OCPI tariff types → the offer's `tariffType`. */
export const OCPI_TARIFF_TYPES: Readonly<Record<string, string>> = {
  AD_HOC_PAYMENT: "ad_hoc",
  PROFILE_CHEAP: "profile_cheap",
  PROFILE_FAST: "profile_fast",
  PROFILE_GREEN: "profile_green",
  REGULAR: "regular",
};

/** OCPI parking types → the site's `details.parkingType`. */
export const OCPI_PARKING_TYPES: Readonly<Record<string, string>> = {
  ALONG_MOTORWAY: "along_motorway",
  PARKING_GARAGE: "parking_garage",
  PARKING_LOT: "parking_lot",
  ON_DRIVEWAY: "on_driveway",
  ON_STREET: "on_street",
  UNDERGROUND_GARAGE: "underground_garage",
};

/** OCPI image categories → the feature's image categories. */
export const OCPI_IMAGE_CATEGORIES: Readonly<Record<string, string | null>> = {
  CHARGER: "site",
  ENTRANCE: "entrance",
  LOCATION: "site",
  NETWORK: "operator_logo",
  OPERATOR: "operator_logo",
  OWNER: "operator_logo",
  OTHER: "other",
};
