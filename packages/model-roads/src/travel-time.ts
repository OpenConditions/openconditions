import { defineKind, defineProperty, quantityIn } from "@openconditions/model";

const DOMAIN = "roads";
const V = "1.0";
const MINUTE = 60;

/**
 * Travel-time routes: stretches between two named points an authority
 * publishes a journey time for (DATEX II predefined itineraries, the
 * signs' "Seattle to Bellevue 22 min"). A route is not a measurement site:
 * it is defined for the time it reports, whatever measures it.
 */
export const ROADS_TRAVEL_TIME_KINDS = [
  defineKind({
    class: "feature",
    code: "travel_time_route",
    domain: DOMAIN,
    version: V,
    description: "A route between two named points with a published journey time.",
    details: (k) => ({
      length: quantityIn("m").optional(),
      /** The journey time at free flow, as the publisher defines it for the route. */
      freeFlowTravelTime: quantityIn("s").optional(),
      fromName: k.Text.optional(),
      toName: k.Text.optional(),
    }),
  }),
];

export const ROADS_TRAVEL_TIME_PROPERTIES = [
  defineProperty({
    code: "traffic.travel_time",
    domain: DOMAIN,
    version: V,
    description: "The journey time along a route.",
    result: { type: "quantity", unit: "s" },
    subjects: [{ kind: "feature", featureKinds: ["travel_time_route"] }],
    freshnessWindowSec: 15 * MINUTE,
    retention: { rawDays: 7, rollup: { period: "hourly" } },
    routingRelevant: true,
  }),
];
