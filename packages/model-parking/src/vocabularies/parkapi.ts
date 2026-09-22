/**
 * ParkAPI v3 vocabularies. The service publishes no schema, so the value sets
 * were taken from a full census of its own data on 2026-09-22: all 32 016
 * parking sites and all 71 sources of https://api.mobidata-bw.de/park-api.
 * `type` mixes car structures with bicycle furniture, so it only classifies a
 * site together with `purpose`.
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
  sourceStatuses: ["ACTIVE", "PROVISIONED", "FAILED", "DISABLED"],
} as const;
