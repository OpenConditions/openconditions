import {
  defineKind,
  defineProperty,
  defineVocabulary,
  Iso8601,
  type PropertyEntry,
} from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "charging";
const V = "1.0";
const MINUTE = 60;
const HOUR = 3600;
/**
 * A driver who finds a charge point broken or blocked can say so; a broken
 * point usually stays broken for hours, so the report outlives a parking
 * spot's, and confirmations can carry it over two days until the operator's
 * own status catches up.
 */
const STATUS_CROWD = { ttlSec: 4 * HOUR, maxLifetimeSec: 48 * HOUR };

/**
 * What a charge point is doing, OCPI's EVSE status vocabulary. Connectors
 * report the same states, so one vocabulary serves both properties.
 */
export const EVSE_STATUSES = [
  "available",
  "charging",
  "occupied",
  "reserved",
  "blocked",
  "out_of_order",
  "inoperative",
  "planned",
  "removed",
  "unknown",
] as const;

/** What a whole site offers, derived from its EVSEs; no source publishes it. */
export const CHARGING_SITE_STATUSES = [
  "available",
  "partially_available",
  "full",
  "out_of_service",
  "closed",
  "unknown",
] as const;

/** OCPI `ConnectorType`, verbatim (2.2.1 plus 2.3's SAE_J3400), plus MCS for megawatt charging. */
export const CONNECTOR_STANDARDS = [
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
  "MCS",
  "UNKNOWN",
] as const;

/** How a connector delivers power: OCPI's `PowerType`. */
export const CONNECTOR_POWER_TYPES = [
  "AC_1_PHASE",
  "AC_2_PHASE",
  "AC_2_PHASE_SPLIT",
  "AC_3_PHASE",
  "DC",
] as const;

/** Where a charging site's vehicles stand: OCPI's `ParkingType` plus `other`. */
export const CHARGING_PARKING_TYPES = [
  "along_motorway",
  "parking_garage",
  "parking_lot",
  "on_driveway",
  "on_street",
  "underground_garage",
  "other",
] as const;

export const evseStatusVocabulary = defineVocabulary({
  code: "evse_status",
  values: EVSE_STATUSES,
  extensible: false,
  description: "What a charge point or one of its connectors is doing.",
});
export const chargingSiteStatusVocabulary = defineVocabulary({
  code: "charging_site_status",
  values: CHARGING_SITE_STATUSES,
  extensible: false,
  description: "What a whole charging site offers; derived from its charge points.",
});
export const connectorStandardVocabulary = defineVocabulary({
  code: "connector_standard",
  values: CONNECTOR_STANDARDS,
  extensible: true,
  description: "Plug and socket standards (OCPI ConnectorType plus MCS).",
});

/**
 * One Feature per OCPI Location / DATEX EnergyInfrastructure station:
 * the charge points are `evse` components and their plugs `connector`
 * components below them, so a status, a tariff and a crowd report all have a
 * subject at the level the source publishes them.
 */
export const CHARGING_KINDS = [
  defineKind({
    class: "component",
    code: "evse",
    version: V,
    description: "One charge point: what a driver plugs into, with its own status.",
    // The eMI3 id is global; the OCPI uid and the DATEX refill point id are an
    // operator's own, which still name one point within one linked site.
    identity: { idSchemes: ["emi3:evse", "oicp:evse", "ocpi:evse", "datex:refill_point"] },
    details: (k) => ({
      /** eMI3 / ISO 15118 id, the one that identifies the point across systems. */
      evseId: z.string().min(1).optional(),
      /** The operator's own id, where it differs from the eMI3 one. */
      uid: z.string().min(1).optional(),
      capabilities: z.array(z.string().min(1)).min(1).optional(),
      parkingRestrictions: z
        .array(z.enum(["ev_only", "plugged", "disabled", "customers", "motorcycles"]))
        .min(1)
        .optional(),
      directions: k.Text.optional(),
      /**
       * One component standing for this many identical charge points that the
       * source does not tell apart; it has no live status.
       */
      quantity: z.number().int().min(2).optional(),
      /** Planned status changes the operator publishes ahead of time. */
      statusSchedule: z
        .array(
          z.strictObject({
            start: Iso8601,
            end: Iso8601.optional(),
            status: k.vocab("evse_status"),
          }),
        )
        .min(1)
        .optional(),
    }),
  }),
  defineKind({
    class: "component",
    code: "connector",
    version: V,
    description: "One plug or socket of a charge point, with its power envelope.",
    // An OCPI connector id ("1", "2") is only unique within its EVSE.
    identity: { idSchemes: ["ocpi:connector"], withinParent: true },
    details: (k) => ({
      standard: k.vocab("connector_standard"),
      format: z.enum(["socket", "cable"]).optional(),
      powerType: z.enum(CONNECTOR_POWER_TYPES).optional(),
      /** Whether the plug delivers AC or DC, where the source says so without naming phases. */
      current: z.enum(["ac", "dc"]).optional(),
      maxVoltage: z.number().positive().optional(),
      maxAmperage: z.number().positive().optional(),
      maxPowerKw: z.number().positive().optional(),
      chargingModes: z
        .array(z.enum(["mode1", "mode2", "mode3", "mode4", "chademo"]))
        .min(1)
        .optional(),
      termsUrl: z.url().optional(),
      /** Ids of the tariffs that apply here; the tariffs themselves are offers. */
      tariffRefs: z.array(z.string().min(1)).min(1).optional(),
    }),
  }),
  defineKind({
    class: "feature",
    code: "charging_site",
    domain: DOMAIN,
    version: V,
    description:
      "A place to charge an electric vehicle: one OCPI location, with its charge points.",
    components: ["evse", "connector"],
    details: (k) => ({
      parkingType: z.enum(CHARGING_PARKING_TYPES).optional(),
      energyMix: z
        .strictObject({
          isGreen: z.boolean().optional(),
          supplierName: z.string().min(1).optional(),
          sources: z
            .array(z.strictObject({ source: z.string().min(1), pct: z.number().min(0).max(100) }))
            .min(1)
            .optional(),
        })
        .optional(),
      directions: k.Text.optional(),
      relatedLocations: z
        .array(z.strictObject({ name: k.Text, point: k.PointGeometry }))
        .min(1)
        .optional(),
      /** OCPI `publish`: whether the operator allows the location to be shown at all. */
      publish: z.boolean().optional(),
      hubOperatorId: z.string().min(1).optional(),
      calibrationLaw: z.string().min(1).optional(),
      dynamicInfoAvailable: z.enum(["true", "false", "auto"]).optional(),
      /** The operator's page for the site; the kernel feature carries no URL. */
      website: z.url().optional(),
      /** A tariff as the publisher wrote it, where it cannot be broken into priced elements. */
      tariffText: k.Text.optional(),
      /** Opening hours as the publisher wrote them, where they are not OSM grammar. */
      openingHoursText: k.Text.optional(),
      brand: z.string().min(1).optional(),
    }),
    linking: {
      idSchemes: [
        "provider",
        "ocpi:location",
        "ocm",
        "bnetza",
        "osm:node",
        "osm:way",
        "osm:relation",
      ],
      alwaysMetres: 20,
      neverMetres: 150,
      attribute: { name: 0.45, operator: 0.75, address: 0.6 },
      // A large operator runs many sites a few streets apart: its name alone
      // is no evidence beyond the next car park.
      attributeWithinMetres: { operator: 50 },
      pendingAttribute: { name: 0.3 },
      nameStopwords: [
        "ev",
        "charging",
        "charger",
        "station",
        "ladestation",
        "ladesaeule",
        "ladesäule",
        "ladepunkt",
        "stromtankstelle",
        "borne",
        "recharge",
        "irve",
        "laadpaal",
        "laadpunt",
        "ac",
        "dc",
      ],
      osm: {
        tags: ["amenity=charging_station"],
        idTags: { "ref:EU:EVSE": "emi3:evse", "ref:ocpi": "ocpi:location" },
      },
    },
  }),
  defineKind({
    class: "offer",
    code: "energy_tariff",
    domain: DOMAIN,
    version: V,
    description: "What charging at a site, charge point or connector costs.",
  }),
];

const EVSE = {
  kind: "feature",
  featureKinds: ["charging_site"],
  componentKinds: ["evse", "connector"],
} as const;

export const CHARGING_PROPERTIES: PropertyEntry[] = [
  defineProperty({
    code: "charging.evse_status",
    domain: DOMAIN,
    version: V,
    description: "What a charge point is doing.",
    result: { type: "category", vocabulary: "evse_status" },
    subjects: [EVSE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true },
    crowd: STATUS_CROWD,
  }),
  defineProperty({
    code: "charging.connector_status",
    domain: DOMAIN,
    version: V,
    description: "What one plug of a charge point is doing, where the source reports per plug.",
    result: { type: "category", vocabulary: "evse_status" },
    subjects: [EVSE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true },
    crowd: STATUS_CROWD,
  }),
  defineProperty({
    code: "charging.site_status",
    domain: DOMAIN,
    version: V,
    description: "What a whole site offers; derived from its charge points, never published.",
    result: { type: "category", vocabulary: "charging_site_status" },
    subjects: [{ kind: "feature", featureKinds: ["charging_site"] }],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true },
  }),
  defineProperty({
    code: "charging.waiting_time",
    domain: DOMAIN,
    version: V,
    description: "How long a driver waits for a free charge point.",
    result: { type: "quantity", unit: "min" },
    subjects: [EVSE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { rawDays: 7 },
  }),
];
