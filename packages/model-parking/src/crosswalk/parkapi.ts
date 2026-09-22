import type { SourceTable } from "@openconditions/model";

/**
 * ParkAPI v3 codes → OpenConditions classifications. A site's classification
 * needs both of its fields: `type` names a structure for cars and a piece of
 * furniture for bicycles, so the same `purpose` prefix decides which of the
 * two a value means. ParkAPI has no lorry purpose at all, so a lorry park it
 * publishes arrives as an ordinary car park.
 */
export const PARKAPI_PARKING_TYPES: SourceTable = {
  "purpose:CAR|type:CAR_PARK": "parking_site.off_street",
  "purpose:CAR|type:UNDERGROUND": "parking_site.off_street",
  "purpose:CAR|type:OFF_STREET_PARKING_GROUND": "parking_site.off_street",
  "purpose:CAR|type:ON_STREET": "parking_site.on_street",
  "purpose:CAR|type:BUILDING": "parking_site.off_street",
  "purpose:CAR|type:OTHER": null,
  // Bicycle and motorcycle furniture: a stand or a locker is a parking site of
  // its own kind, always off-street whatever it is built from.
  "purpose:BIKE|type:LOCKERS": "parking_site.off_street",
  "purpose:BIKE|type:SHED": "parking_site.off_street",
  "purpose:BIKE|type:FLOOR": "parking_site.off_street",
  "purpose:BIKE|type:WALL_LOOPS": "parking_site.on_street",
  "purpose:BIKE|type:SAFE_WALL_LOOPS": "parking_site.on_street",
  "purpose:BIKE|type:STANDS": "parking_site.on_street",
  "purpose:BIKE|type:TWO_TIER": "parking_site.off_street",
  "purpose:BIKE|type:LOCKBOX": "parking_site.off_street",
  "purpose:BIKE|type:BUILDING": "parking_site.off_street",
  "purpose:BIKE|type:OTHER": null,
  "purpose:MOTORCYCLE|type:ON_STREET": "parking_site.on_street",
  "purpose:MOTORCYCLE|type:CAR_PARK": "parking_site.off_street",
  "purpose:MOTORCYCLE|type:OTHER": null,
  // Left luggage and parcel lockers are not vehicle parking.
  "purpose:ITEM|type:LOCKERS": null,
  "purpose:ITEM|type:LOCKBOX": null,
  "purpose:ITEM|type:OTHER": null,
};

/** The vehicle a site's areas are laid out for, from the same `purpose`. */
export const PARKAPI_VEHICLE_TYPES: Readonly<Record<string, string>> = {
  CAR: "car",
  BIKE: "bicycle",
  MOTORCYCLE: "motorcycle",
  ITEM: "any",
};

/**
 * The capacity fields that are areas of their own. ParkAPI publishes one
 * capacity per user group next to the total, so each becomes a
 * `parking_area` component and the remainder stays the site's own capacity.
 */
export const PARKAPI_CAPACITY_AREAS: Readonly<Record<string, string>> = {
  capacity_disabled: "disabled",
  capacity_woman: "women",
  capacity_family: "family",
  capacity_charging: "ev_charging",
};
