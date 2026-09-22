import {
  defineKind,
  defineProperty,
  defineVocabulary,
  type PropertyEntry,
} from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "fuel";
const V = "1.0";
const HOUR = 3600;

/**
 * The grades sources price separately; a grade is a product, not a pump. The
 * last five are grades no European standard names but Spain publishes a price
 * column for: a 25 % ethanol blend, renewable petrol, the red diesel sold for
 * agricultural use, methanol and ammonia.
 */
export const FUEL_GRADES = [
  "e5",
  "e10",
  "sp98",
  "e85",
  "diesel",
  "diesel_premium",
  "hvo100",
  "b7",
  "b10",
  "b100",
  "lpg",
  "cng",
  "lng",
  "h2_350",
  "h2_700",
  "adblue",
  "ethanol",
  "kerosene",
  "e25",
  "renewable_petrol",
  "agricultural_diesel",
  "methanol",
  "ammonia",
] as const;

export const fuelGradeVocabulary = defineVocabulary({
  code: "fuel_grade",
  values: FUEL_GRADES,
  extensible: true,
  description: "Fuel grades sold at a station, each priced on its own.",
});

/** The sale units prices are published per; the product fixes which one applies. */
export const FUEL_UNITS = ["L", "kg", "m3"] as const;

/**
 * A station and the products it sells. The price subject is the product, not
 * the station and not a pump: sources publish one scalar price per
 * grade, service level and price level, and that combination is what stays
 * comparable over time.
 */
export const FUEL_KINDS = [
  defineKind({
    class: "component",
    code: "fuel_product",
    version: V,
    description:
      "One priced product of a station: a grade at a service and price level, sold per litre, kilogram or cubic metre.",
    details: (k) => ({
      grade: k.vocab("fuel_grade"),
      /** Self service and attended service are priced differently in IT and PT. */
      service: z.enum(["self", "served", "unknown"]).optional(),
      priceLevel: z.enum(["standard", "member", "card", "fleet", "cash", "unknown"]).optional(),
      vehicleScope: z.enum(["any", "car", "hgv"]).optional(),
      per: z.enum(FUEL_UNITS),
      /** Whether the published price includes taxes; ES and US publish both. */
      priceBasis: z.enum(["gross", "net"]),
    }),
  }),
  defineKind({
    class: "feature",
    code: "fuel_station",
    domain: DOMAIN,
    version: V,
    description: "A filling station, with the products it sells.",
    components: ["fuel_product"],
    details: () => ({
      brand: z.string().min(1).optional(),
      /**
       * Whether the source lists every grade the station sells. Only then is
       * a missing product a grade that is not sold rather than unknown.
       */
      productsComplete: z.boolean(),
      truckSuitable: z.boolean().optional(),
    }),
    linking: {
      idSchemes: ["provider", "osm:node", "osm:way", "osm:relation"],
      alwaysMetres: 30,
      neverMetres: 150,
      attribute: { name: 0.5, operator: 0.75, address: 0.6 },
      pendingAttribute: { name: 0.34 },
      nameStopwords: [
        "tankstelle",
        "station",
        "service",
        "gas",
        "fuel",
        "petrol",
        "estacion",
        "servicio",
        "distributore",
        "carburant",
        "station-service",
      ],
      osm: { tags: ["amenity=fuel"] },
    },
  }),
];

const PRODUCT = {
  kind: "feature",
  featureKinds: ["fuel_station"],
  componentKinds: ["fuel_product"],
} as const;

/**
 * Prices are observations, not offers: a scalar per product with a
 * timestamp, which decays, fuses and federates like any other reading. A
 * regional average has no station to hang on, so its subject is the
 * administrative area and the grade moves into the qualifiers.
 */
export const FUEL_PROPERTIES: PropertyEntry[] = [
  defineProperty({
    code: "fuel.price",
    domain: DOMAIN,
    version: V,
    description: "What a litre, kilogram or cubic metre of one product costs.",
    result: { type: "money", per: FUEL_UNITS },
    subjects: [PRODUCT, { kind: "location" }],
    qualifiers: (k) => ({
      /** Regional averages: the grade the average is over, since there is no product. */
      product: k.vocab("fuel_grade").optional(),
    }),
    refine: (o, ctx) => {
      const subject = o["subject"] as { kind: string };
      const qualifiers = o["qualifiers"] as { product?: string } | undefined;
      if (subject.kind === "location" && qualifiers?.product === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["qualifiers", "product"],
          message: "a regional average names the grade it averages",
        });
      }
      if (subject.kind === "feature" && qualifiers !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["qualifiers"],
          message: "a product's price takes its grade from the component",
        });
      }
    },
    freshnessWindowSec: 24 * HOUR,
    retention: { rawDays: 30, rollup: { period: "daily" } },
  }),
  defineProperty({
    code: "fuel.price_cap",
    domain: DOMAIN,
    version: V,
    description: "A regulated maximum price for one grade in an area.",
    result: { type: "money", per: FUEL_UNITS },
    subjects: [{ kind: "location" }],
    qualifiers: (k) => ({ product: k.vocab("fuel_grade") }),
    freshnessWindowSec: 7 * 24 * HOUR,
  }),
  defineProperty({
    code: "fuel.product_available",
    domain: DOMAIN,
    version: V,
    description: "Whether a product is in stock, where a source publishes stock-outs.",
    result: { type: "boolean" },
    subjects: [PRODUCT],
    freshnessWindowSec: 24 * HOUR,
    retention: { changeOnly: true },
  }),
];
