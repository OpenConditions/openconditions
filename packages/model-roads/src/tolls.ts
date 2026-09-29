import {
  defineKind,
  defineProperty,
  PAYMENT_METHODS,
  quantityIn,
  VEHICLE_CLASSES,
} from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "roads";
const V = "1.0";

const tolling = {
  /** The tolling scheme, verbatim ("AutoPASS", "Good To Go!"). */
  system: z.string().min(1).optional(),
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).min(1).optional(),
  /** Electronic tags accepted, verbatim. */
  tagSystems: z.array(z.string().min(1)).min(1).optional(),
};

/**
 * Tolls. A toll point charges a passage; a toll section charges a journey
 * between an entry and an exit, one section per priced pair, so a price
 * always has a feature as its subject and no price matrix enters a result.
 * Static tariffs are `toll` offers; a price that changes with traffic
 * (express lanes) is the `toll.price` observation.
 */
export const ROADS_TOLL_KINDS = [
  defineKind({
    class: "component",
    code: "toll_lane",
    version: V,
    description: "One lane of a toll plaza and what it accepts.",
    details: () => ({
      laneIndex: z.number().int().positive().optional(),
      paymentMethods: z.array(z.enum(PAYMENT_METHODS)).min(1).optional(),
      vehicleClasses: z.array(z.enum(VEHICLE_CLASSES)).min(1).optional(),
    }),
  }),
  defineKind({
    class: "feature",
    code: "toll_point",
    domain: DOMAIN,
    version: V,
    description: "A place a toll is charged for passing: a plaza, a gantry, a toll station.",
    components: ["toll_lane"],
    traits: ["operated_site"],
    details: () => ({
      ...tolling,
      /**
       * A rule that caps what repeated passages cost: within the window,
       * only the first (or the most expensive) passage is charged.
       */
      passageRule: z
        .strictObject({ window: quantityIn("s"), charged: z.enum(["first", "most_expensive"]) })
        .optional(),
    }),
    linking: {
      idSchemes: ["osm:node", "osm:way"],
      alwaysMetres: 30,
      neverMetres: 150,
      attribute: { name: 0.6 },
      nameStopwords: ["toll", "peage", "péage", "bomstasjon", "maut", "plaza"],
      osm: { tags: ["barrier=toll_booth", "highway=toll_gantry"] },
    },
  }),
  defineKind({
    class: "feature",
    code: "toll_section",
    domain: DOMAIN,
    version: V,
    description: "A tolled journey between one entry and one exit.",
    components: ["toll_lane"],
    details: (k) => ({
      ...tolling,
      entryName: k.Text.optional(),
      exitName: k.Text.optional(),
      length: quantityIn("m").optional(),
    }),
  }),
  defineKind({
    class: "offer",
    code: "toll",
    domain: DOMAIN,
    version: V,
    description: "The tariff of a toll point or section, per vehicle class and time of day.",
  }),
];

export const ROADS_TOLL_PROPERTIES = [
  defineProperty({
    code: "toll.price",
    domain: DOMAIN,
    version: V,
    description: "The toll for one journey now, where it changes with traffic.",
    result: { type: "money", per: ["1"] },
    subjects: [
      {
        kind: "feature",
        featureKinds: ["toll_section", "toll_point"],
        componentKinds: ["toll_lane"],
      },
    ],
    qualifiers: () => ({ vehicleClass: z.enum(VEHICLE_CLASSES).optional() }),
    freshnessWindowSec: 15 * 60,
    retention: { changeOnly: true, rawDays: 30 },
  }),
];
