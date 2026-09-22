import {
  defineKind,
  defineProperty,
  defineVocabulary,
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
  "caravan",
  "any",
] as const;

/** Who an area is reserved for. A site's untyped spaces are the `any` area. */
export const PARKING_USER_GROUPS = [
  "any",
  "disabled",
  "women",
  "family",
  "ev_charging",
  "car_sharing",
  "residents",
  "short_term",
  "long_term",
  "hazmat",
] as const;

const PARKING_USAGES = [
  "park_and_ride",
  "carpool",
  "truck",
  "coach",
  "customer",
  "residents",
  "event",
] as const;

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
    details: () => ({
      vehicleType: z.enum(PARKING_VEHICLE_TYPES),
      userGroup: z.enum(PARKING_USER_GROUPS).optional(),
      capacity: z.number().int().nonnegative().optional(),
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
    types: {
      off_street: [],
      on_street: [],
      park_and_ride: [],
      truck_parking: [],
      rest_area_parking: [],
    },
    components: ["parking_area", "parking_space"],
    details: (k) => ({
      /** The physical structure, independent of what the site is used for. */
      layout: z
        .enum([
          "single_level",
          "multi_storey",
          "underground",
          "surface",
          "automated",
          "covered",
          "nested",
          "unknown",
        ])
        .optional(),
      capacityTotal: z.number().int().nonnegative().optional(),
      heightLimit: Quantity.optional(),
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
      supervision: z
        .enum(["remote", "on_site", "control_centre", "patrol", "none", "unknown"])
        .optional(),
      entrances: z
        .array(
          z.strictObject({
            point: k.PointGeometry,
            kind: z.enum(["vehicle_entrance", "vehicle_exit", "pedestrian"]),
          }),
        )
        .min(1)
        .optional(),
      maxStay: Quantity.optional(),
      reservation: z.boolean().optional(),
      /** Every usage the site is published for, the primary one included. */
      usage: z.array(z.enum(PARKING_USAGES)).min(1).optional(),
    }),
    linking: {
      idSchemes: ["datex:parking", "tpims:site", "osm:node", "osm:way", "osm:relation"],
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
    retention: { changeOnly: true, rollup: { period: "hourly" } },
  }),
  defineProperty({
    code: "parking.occupied",
    domain: DOMAIN,
    version: V,
    description: "Spaces in use, where the source counts those instead of the free ones.",
    result: { type: "count" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true, rollup: { period: "hourly" } },
  }),
  defineProperty({
    code: "parking.occupancy_pct",
    domain: DOMAIN,
    version: V,
    description: "Share of the capacity in use, where the source publishes no counts.",
    result: { type: "quantity", unit: "%" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { rollup: { period: "hourly" } },
  }),
  defineProperty({
    code: "parking.status",
    domain: DOMAIN,
    version: V,
    description: "Whether the site is open, and whether it still has room.",
    result: { type: "category", vocabulary: "parking_status" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true },
  }),
  defineProperty({
    code: "parking.trend",
    domain: DOMAIN,
    version: V,
    description: "Which way occupancy is moving, as the source states it.",
    result: { type: "category", vocabulary: "trend" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true },
  }),
];
