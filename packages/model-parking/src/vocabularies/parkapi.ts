/**
 * ParkAPI v3 vocabularies, as the service's OpenAPI document enumerates them
 * (https://api.mobidata-bw.de/park-api/documentation/public.json, schemas
 * `ParkingSite`, `ParkingSiteRestriction` and `Source`; ParkAPI 0.49.2). A
 * test holds each list to the pinned document. `type` mixes car structures
 * with bicycle furniture, so it only classifies a site together with
 * `purpose`. `restrictionTypes` are the audiences a site's `restrictions[]`
 * entries name.
 */
export const PARKAPI_V3 = {
  version: "v3",
  siteTypes: [
    "CAR_PARK",
    "UNDERGROUND",
    "OFF_STREET_PARKING_GROUND",
    "ON_STREET",
    "OTHER",
    "LOCKERS",
    "SHED",
    "FLOOR",
    "WALL_LOOPS",
    "BUILDING",
    "STANDS",
    "TWO_TIER",
    "LOCKBOX",
    "SAFE_WALL_LOOPS",
  ],
  purposes: ["CAR", "BIKE", "ITEM", "MOTORCYCLE"],
  restrictionTypes: [
    "DISABLED",
    "WOMEN",
    "FAMILY",
    "CARSHARING",
    "CHARGING",
    "TAXI",
    "DELIVERY",
    "TRUCK",
    "BUS",
    "CUSTOMER",
    "RESIDENT",
    "CARAVAN",
    "CARGOBIKE",
  ],
  parkAndRideTypes: ["CARPOOL", "TRAIN", "BUS", "TRAM", "YES", "NO"],
  supervisionTypes: ["YES", "NO", "VIDEO", "ATTENDED"],
  openingStatuses: ["OPEN", "CLOSED", "UNKNOWN"],
  externalIdentifierTypes: ["OSM", "DHID"],
  sourceStatuses: ["ACTIVE", "PROVISIONED", "FAILED", "DISABLED"],
} as const;
