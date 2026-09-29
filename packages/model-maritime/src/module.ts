import {
  defineDomain,
  defineKind,
  defineProperty,
  defineVocabulary,
  extendVocabulary,
  Iso8601,
  quantityIn,
  type RegistryModule,
  SeasonalWindow,
} from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "maritime";
const V = "1.0";

export const FERRY_STATUSES = [
  "on_schedule",
  "delayed",
  "cancelled",
  "suspended",
  "running",
  "unknown",
] as const;

export const ferryStatusVocabulary = defineVocabulary({
  code: "ferry_status",
  values: FERRY_STATUSES,
  extensible: false,
  description:
    "Whether a ferry service runs: to schedule, late, cancelled for a sailing, suspended for a period, or running without a schedule claim.",
});

/**
 * What a sailing is reported on: a route or one of its legs, or the
 * terminal it departs from where the operator names no route (Washington
 * State Ferries publishes space and cancellations per departing terminal).
 */
const SAILING = {
  kind: "feature",
  featureKinds: ["ferry_route", "ferry_terminal"],
  componentKinds: ["ferry_leg"],
} as const;

const departure = () => ({
  /** One sailing, named by its scheduled departure. */
  departure: Iso8601,
});

/**
 * The maritime registry module: road ferries. A route joins its terminals;
 * a leg is one terminal-to-terminal crossing of a route, the unit a sailing
 * is reported for. Timetables stay with the transit domain; what a road
 * user needs from a ferry is whether it runs and whether a car fits on.
 */
export const maritimeModule: RegistryModule = {
  name: "maritime",
  entries: [
    defineDomain({
      code: DOMAIN,
      description: "Ferries that carry road traffic: routes, terminals, sailings.",
    }),
    extendVocabulary({
      vocabulary: "external_id_scheme",
      values: ["netex:line", "netex:stop_place"],
    }),
    ferryStatusVocabulary,
    defineKind({
      class: "component",
      code: "ferry_leg",
      version: V,
      description: "One terminal-to-terminal crossing of a ferry route.",
      details: (k) => ({ from: k.RecordRef, to: k.RecordRef }),
    }),
    defineKind({
      class: "feature",
      code: "ferry_route",
      domain: DOMAIN,
      version: V,
      description: "A ferry service between terminals that carries vehicles or foot passengers.",
      components: ["ferry_leg"],
      details: (k) => ({
        terminals: z.array(k.RecordRef).min(2).optional(),
        vehicleCapable: z.boolean().optional(),
        /** When a seasonal route runs; absent for a year-round route. */
        season: SeasonalWindow.optional(),
        crossingTime: quantityIn("s").optional(),
        scheduleUrl: z.url().optional(),
        /** The operator's own route code. */
        operatorRoute: z.string().min(1).optional(),
      }),
    }),
    defineKind({
      class: "feature",
      code: "ferry_terminal",
      domain: DOMAIN,
      version: V,
      description: "A quay or terminal where vehicles board a ferry.",
      details: () => ({ berths: z.number().int().positive().optional() }),
      linking: {
        idSchemes: ["netex:stop_place", "osm:node", "osm:way"],
        alwaysMetres: 100,
        neverMetres: 500,
        attribute: { name: 0.5 },
        nameStopwords: ["ferry", "terminal", "ferjekai", "ferjeleie", "fährhafen", "quay", "dock"],
        osm: { tags: ["amenity=ferry_terminal"] },
      },
    }),
    defineKind({
      class: "offer",
      code: "fare",
      domain: DOMAIN,
      version: V,
      description: "What a crossing costs, per vehicle and passenger.",
    }),
    defineProperty({
      code: "ferry.status",
      domain: DOMAIN,
      version: V,
      description: "Whether a route, a leg or one sailing runs.",
      result: { type: "category", vocabulary: "ferry_status" },
      subjects: [SAILING],
      qualifiers: () => ({ departure: Iso8601.optional() }),
      freshnessWindowSec: 3600,
      retention: { changeOnly: true },
      routingRelevant: true,
    }),
    defineProperty({
      code: "ferry.vehicle_space",
      domain: DOMAIN,
      version: V,
      description: "Vehicle spaces still free on one sailing for drivers without a reservation.",
      result: { type: "count" },
      subjects: [SAILING],
      qualifiers: departure,
      freshnessWindowSec: 900,
      retention: { changeOnly: true, rawDays: 7 },
    }),
  ],
};
