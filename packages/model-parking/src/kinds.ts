import {
  defineKind,
  defineProperty,
  defineVocabulary,
  LineStringGeometry,
  MultiLineStringGeometry,
  MultiPolygonGeometry,
  OpeningHours,
  PolygonGeometry,
  type PropertyEntry,
  Quantity,
} from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "parking";
const V = "1.0";
const MINUTE = 60;

export const PARKING_STATUSES = [
  "open",
  "closed",
  "full",
  "almost_full",
  "spaces_available",
  "closed_abnormally",
  "unknown",
] as const;

/** What a site does to be secure; DATEX publishes several of them per site. */
export const PARKING_SECURITY_FEATURES = [
  "social_control",
  "security_staff",
  "external_security",
  "cctv",
  "dog",
  "guard_24h",
  "lighting",
  "flood_light",
  "fences",
  "separated_area",
  "none",
] as const;

export const parkingSecurityVocabulary = defineVocabulary({
  code: "parking_security",
  values: PARKING_SECURITY_FEATURES,
  extensible: false,
  description: "Security measures a parking site has.",
});

export const parkingStatusVocabulary = defineVocabulary({
  code: "parking_status",
  values: PARKING_STATUSES,
  extensible: false,
  description: "Whether a parking site takes vehicles, and whether it has room.",
});

/** Vehicles a parking area is laid out for; the kernel's vehicle classes are about road use. */
export const PARKING_VEHICLE_TYPES = [
  "car",
  "truck",
  "bus",
  "coach",
  "motorcycle",
  "bicycle",
  "cargo_bike",
  "caravan",
  "any",
] as const;

export type ParkingVehicleType = (typeof PARKING_VEHICLE_TYPES)[number];

/**
 * Who an area is reserved for. A site's untyped spaces are the `any` area.
 * `customers` are a business's own (shoppers, hotel guests), `taxi` a rank,
 * `delivery` a loading bay.
 */
export const PARKING_USER_GROUPS = [
  "any",
  "disabled",
  "women",
  "family",
  "ev_charging",
  "car_sharing",
  "residents",
  "customers",
  "taxi",
  "delivery",
  "short_term",
  "long_term",
  "hazmat",
] as const;

export type ParkingUserGroup = (typeof PARKING_USER_GROUPS)[number];

export type ParkingStatus = (typeof PARKING_STATUSES)[number];

/** What a site is for: the `parking_site` feature types. */
export const PARKING_SITE_TYPES = [
  "off_street",
  "on_street",
  "park_and_ride",
  "truck_parking",
  "rest_area_parking",
] as const;

export type ParkingSiteType = (typeof PARKING_SITE_TYPES)[number];

/**
 * The physical structure of a site, independent of what it is used for.
 * `underground_and_multi_storey` has levels both below and above ground.
 */
export const PARKING_LAYOUTS = [
  "single_level",
  "multi_storey",
  "underground",
  "underground_and_multi_storey",
  "surface",
  "automated",
  "covered",
  "nested",
  "unknown",
] as const;

export type ParkingLayout = (typeof PARKING_LAYOUTS)[number];

/**
 * Every usage a site is published for: `kiss_and_ride` is dropping off or
 * picking up passengers, `park_and_cycle` and `park_and_walk` leaving the
 * car to go on by bicycle or on foot, `valet` handing the car to staff,
 * `loading` a bay to load and unload goods, `overnight` a stay overnight.
 */
export const PARKING_USAGES = [
  "park_and_ride",
  "park_and_cycle",
  "park_and_walk",
  "kiss_and_ride",
  "carpool",
  "car_sharing",
  "valet",
  "truck",
  "coach",
  "customer",
  "residents",
  "event",
  "loading",
  "overnight",
] as const;

export type ParkingUsage = (typeof PARKING_USAGES)[number];

/** How a site is watched; `supervised` says it is, without saying how. */
export const PARKING_SUPERVISIONS = [
  "remote",
  "on_site",
  "control_centre",
  "patrol",
  "supervised",
  "none",
  "unknown",
] as const;

export type ParkingSupervision = (typeof PARKING_SUPERVISIONS)[number];

/** The angle of a site's bays to the kerb or aisle they open onto. */
export const PARKING_ORIENTATIONS = ["parallel", "diagonal", "perpendicular"] as const;

/**
 * Where kerbside bays are: in the carriageway, on the kerb, half on it, or on
 * the shoulder (OpenStreetMap's `parking:<side>` values).
 */
export const PARKING_KERB_POSITIONS = ["lane", "on_kerb", "half_on_kerb", "shoulder"] as const;

/**
 * The ways into and out of a site: for vehicles, on foot, for bicycles, an
 * emergency exit, and the return of rental cars.
 */
export const PARKING_ENTRANCES = [
  "vehicle_entrance",
  "vehicle_exit",
  "pedestrian",
  "bicycle",
  "emergency_exit",
  "rental_car_return",
] as const;

/** The shapes a site's outline takes: an area, or a line of kerbside bays. */
export const ParkingOutlineGeometry = z.discriminatedUnion("type", [
  PolygonGeometry,
  MultiPolygonGeometry,
  LineStringGeometry,
  MultiLineStringGeometry,
]);

/**
 * Parking sites and the sub-units their occupancy is reported for. A site is
 * one physical place to park; the areas are the parts a source counts
 * separately (truck spaces, disabled bays, the charging row). Areas are
 * components, not a vector result, because each has its own capacity,
 * dimensions and occupancy series.
 */
export const PARKING_KINDS = [
  defineKind({
    class: "component",
    code: "parking_area",
    version: V,
    description: "The part of a site laid out for one vehicle type and user group.",
    // No source publishes area ids another source shares; the vehicle type and
    // user group are what an area is.
    identity: { fields: ["vehicleType", "userGroup"] },
    details: () => ({
      vehicleType: z.enum(PARKING_VEHICLE_TYPES),
      userGroup: z.enum(PARKING_USER_GROUPS).optional(),
      capacity: z.number().int().nonnegative().optional(),
      /**
       * When the area's restriction holds: its spaces are kept for its user
       * group, and its maximum stay applies, during these hours only.
       */
      hours: OpeningHours.optional(),
      maxStay: Quantity.optional(),
      dimensions: z
        .strictObject({
          length: Quantity.optional(),
          width: Quantity.optional(),
          height: Quantity.optional(),
        })
        .optional(),
    }),
  }),
  defineKind({
    class: "component",
    code: "parking_space",
    version: V,
    description: "One numbered bay, where a source publishes single spaces.",
    details: () => ({
      number: z.string().min(1).optional(),
      vehicleType: z.enum(PARKING_VEHICLE_TYPES).optional(),
      userGroup: z.enum(PARKING_USER_GROUPS).optional(),
    }),
  }),
  defineKind({
    class: "feature",
    code: "parking_site",
    domain: DOMAIN,
    version: V,
    description: "A place to park: a garage, a lot, a stretch of on-street bays, a lorry park.",
    types: Object.fromEntries(PARKING_SITE_TYPES.map((type) => [type, []])),
    components: ["parking_area", "parking_space"],
    details: (k) => ({
      /** The physical structure, independent of what the site is used for. */
      layout: z.enum(PARKING_LAYOUTS).optional(),
      capacityTotal: z.number().int().nonnegative().optional(),
      /**
       * The least and the most spaces a source estimates where it cannot count
       * them, such as along a kerb measured by its length.
       */
      capacityRange: z
        .strictObject({
          min: z.number().int().nonnegative().optional(),
          max: z.number().int().nonnegative().optional(),
        })
        .optional(),
      /** How many levels (decks, storeys) the site parks vehicles on. */
      levels: z.number().int().positive().optional(),
      heightLimit: Quantity.optional(),
      widthLimit: Quantity.optional(),
      lengthLimit: Quantity.optional(),
      weightLimit: Quantity.optional(),
      /**
       * An audited rating of a lorry park, under the scheme that awarded it:
       * ESPORG grades a site bronze to platinum, the EU LABEL project rates
       * security and service 1 to 5. The level stays the scheme's own word,
       * because the two scales do not convert into each other.
       */
      securityRating: z
        .strictObject({ scheme: z.enum(["esporg", "eu_label"]), level: z.string().min(1) })
        .optional(),
      serviceRating: z
        .strictObject({ scheme: z.literal("eu_label"), level: z.string().min(1) })
        .optional(),
      /** What the site does to be secure, rather than how it was rated. */
      securityFeatures: z.array(k.vocab("parking_security")).min(1).optional(),
      supervision: z.enum(PARKING_SUPERVISIONS).optional(),
      entrances: z
        .array(
          z.strictObject({
            point: k.PointGeometry,
            kind: z.enum(PARKING_ENTRANCES),
          }),
        )
        .min(1)
        .optional(),
      maxStay: Quantity.optional(),
      reservation: z.boolean().optional(),
      /** How the site's bays are laid out. */
      bays: z
        .strictObject({
          orientation: z.enum(PARKING_ORIENTATIONS).optional(),
          position: z.enum(PARKING_KERB_POSITIONS).optional(),
          /** The side of the road the bays are on, looking along the outline as drawn. */
          side: z.enum(["left", "right"]).optional(),
        })
        .optional(),
      /**
       * The site's extent as the source draws it: its area, or the line of its
       * kerbside bays. The location stays the site's point, where it is shown
       * and linked. A line runs along the road's centre line or along the
       * bays' own, as `line` says where the source does.
       */
      outline: z
        .strictObject({
          geometry: ParkingOutlineGeometry,
          line: z.enum(["road_centre", "bays_centre"]).optional(),
        })
        .optional(),
      /** The public transport stops a park-and-ride site serves, by their ids. */
      stops: z.array(k.ExternalId).min(1).optional(),
      /** Every usage the site is published for, the primary one included. */
      usage: z.array(z.enum(PARKING_USAGES)).min(1).optional(),
      /** The operator's page for the site; the kernel feature carries no URL. */
      website: z.url().optional(),
      /** A tariff as the publisher wrote it, where it cannot be broken into priced elements. */
      tariffText: k.Text.optional(),
      /** Opening hours as the publisher wrote them, where they are not OSM grammar. */
      openingHoursText: k.Text.optional(),
      /**
       * The publisher states opening hours in a form the parser cannot read
       * whole; rather than narrowed ones, the site has none.
       */
      openingHoursUnreadable: z.literal(true).optional(),
    }),
    linking: {
      idSchemes: ["provider", "datex:parking", "tpims:site", "osm:node", "osm:way", "osm:relation"],
      alwaysMetres: 40,
      neverMetres: 150,
      attribute: { name: 0.5, address: 0.6 },
      pendingAttribute: { name: 0.34 },
      nameStopwords: [
        "parking",
        "parkplatz",
        "parkhaus",
        "tiefgarage",
        "garage",
        "parkgarage",
        "carpark",
        "lot",
        "car",
        "park",
        "pr",
        "parkeergarage",
        "parcheggio",
        "aparcamiento",
      ],
      /** A kerbside stretch and a garage are never one site; everything else may be. */
      typeCompatible: (a, b) =>
        a === b || (a !== "on_street" && b !== "on_street") || a === undefined || b === undefined,
      osm: { tags: ["amenity=parking"] },
    },
  }),
  defineKind({
    class: "offer",
    code: "parking_rate",
    domain: DOMAIN,
    version: V,
    description: "What parking at a site or in one of its areas costs.",
  }),
];

const SITE = {
  kind: "feature",
  featureKinds: ["parking_site"],
  componentKinds: ["parking_area", "parking_space"],
} as const;

/** Occupancy as sources publish it: free spaces, taken spaces, a share, a state. */
export const PARKING_PROPERTIES: PropertyEntry[] = [
  defineProperty({
    code: "parking.available",
    domain: DOMAIN,
    version: V,
    description: "Spaces free to park in now.",
    result: { type: "count" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true, latestOnly: true },
  }),
  defineProperty({
    code: "parking.occupied",
    domain: DOMAIN,
    version: V,
    description: "Spaces in use, where the source counts those instead of the free ones.",
    result: { type: "count" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true, latestOnly: true },
  }),
  defineProperty({
    code: "parking.occupancy_pct",
    domain: DOMAIN,
    version: V,
    description: "Share of the capacity in use, where the source publishes no counts.",
    result: { type: "quantity", unit: "%" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { latestOnly: true },
  }),
  defineProperty({
    code: "parking.status",
    domain: DOMAIN,
    version: V,
    description: "Whether the site is open, and whether it still has room.",
    result: { type: "category", vocabulary: "parking_status" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true, latestOnly: true },
    // "Full" at a car park changes within the hour.
    crowd: { ttlSec: 30 * MINUTE, maxLifetimeSec: 180 * MINUTE },
  }),
  defineProperty({
    code: "parking.trend",
    domain: DOMAIN,
    version: V,
    description: "Which way occupancy is moving, as the source states it.",
    result: { type: "category", vocabulary: "trend" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true, latestOnly: true },
  }),
];
