import type { SourceTable } from "@openconditions/model";

/**
 * ParkAPI v3 codes → OpenConditions classifications. A site's classification
 * needs both of its fields: `type` names a structure for cars and a piece of
 * furniture for bicycles, so the same `purpose` prefix decides which of the
 * two a value means. ParkAPI has no lorry purpose at all: a lorry park it
 * publishes arrives as a car park restricted to `TRUCK` as a whole.
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
 * The area a site's `restrictions[]` entry of a ParkAPI audience (`type`)
 * stands for: a user group of the site's own vehicle type, or a vehicle type
 * of its own. An entry with its own capacity is a `parking_area` component
 * and the remainder stays the site's own capacity. `TAXI`, `DELIVERY`,
 * `CUSTOMER` and `CARGOBIKE` have no area, nor has an entry without a type,
 * which restricts every audience. A `CUSTOMER` entry covering the whole site
 * makes it a customers' car park instead.
 */
export const PARKAPI_RESTRICTION_AREAS: Readonly<
  Record<string, { vehicleType?: string; userGroup: string } | null>
> = {
  DISABLED: { userGroup: "disabled" },
  WOMEN: { userGroup: "women" },
  FAMILY: { userGroup: "family" },
  CHARGING: { userGroup: "ev_charging" },
  CARSHARING: { userGroup: "car_sharing" },
  RESIDENT: { userGroup: "residents" },
  TRUCK: { vehicleType: "truck", userGroup: "any" },
  BUS: { vehicleType: "bus", userGroup: "any" },
  CARAVAN: { vehicleType: "caravan", userGroup: "any" },
  TAXI: null,
  DELIVERY: null,
  CUSTOMER: null,
  CARGOBIKE: null,
};

/**
 * How a site is watched, from its `supervision_type`: `ATTENDED` is staff on
 * site. `VIDEO` is video surveillance, which the model holds as the `cctv`
 * security feature rather than a supervision, since ParkAPI does not say
 * whether anyone watches the cameras. `YES` says a site is supervised but
 * not how, and the model's supervision values each name how.
 */
export const PARKAPI_SUPERVISION: Readonly<Record<string, string | null>> = {
  NO: "none",
  ATTENDED: "on_site",
  VIDEO: null,
  YES: null,
};
