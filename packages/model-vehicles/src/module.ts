import {
  defineDomain,
  defineKind,
  defineProperty,
  defineResultSchema,
  type RegistryModule,
} from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "vehicles";
const V = "1.0";

export const VEHICLE_ACTIVITIES = [
  "plowing",
  "salting",
  "deadheading",
  "idle",
  "responding",
  "unknown",
] as const;

/**
 * The vehicles registry module: agency fleets (snowplows, spreaders, incident
 * response) whose positions an authority publishes from its own tracking.
 * Crowd probe positions never become these records.
 */
export const vehiclesModule: RegistryModule = {
  name: "vehicles",
  entries: [
    defineDomain({
      code: DOMAIN,
      description:
        "Service vehicles an authority operates and tracks: maintenance and response fleets.",
    }),
    defineKind({
      class: "feature",
      code: "service_vehicle",
      domain: DOMAIN,
      version: V,
      description: "A tracked maintenance or response vehicle.",
      types: {
        snowplow: [],
        salt_spreader: [],
        sweeper: [],
        incident_response: [],
        patrol: [],
        mower: [],
        other: [],
      },
      details: () => ({
        fleetId: z.string().min(1).optional(),
        agency: z.string().min(1).optional(),
        capabilities: z
          .array(z.enum(["plow", "salt", "brine", "sand"]))
          .min(1)
          .optional(),
      }),
    }),
    defineResultSchema({
      code: "vehicle_position",
      version: V,
      description: "Where a vehicle is and what it is doing.",
      shape: (k) => ({
        point: k.PointGeometry,
        bearingDeg: z.number().min(0).lt(360).optional(),
        speed: z
          .strictObject({ value: z.number().nonnegative(), unit: z.literal("km/h") })
          .optional(),
        activity: z.enum(VEHICLE_ACTIVITIES).optional(),
        plowUp: z.boolean().optional(),
        spreaderOn: z.boolean().optional(),
        routeName: z.string().min(1).optional(),
      }),
    }),
    defineProperty({
      code: "vehicle.position",
      domain: DOMAIN,
      version: V,
      description: "A service vehicle's reported position and activity.",
      result: { type: "structured", schema: "vehicle_position" },
      subjects: [{ kind: "feature", featureKinds: ["service_vehicle"] }],
      freshnessWindowSec: 600,
      retention: { rawDays: 2 },
    }),
  ],
};
