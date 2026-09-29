import {
  CountryCode,
  defineDomain,
  defineKind,
  defineProperty,
  defineResultSchema,
  defineVocabulary,
  type RegistryModule,
  VEHICLE_CLASSES,
} from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "border";
const V = "1.0";

export const BORDER_MODES = ["commercial", "passenger", "pedestrian", "bus", "rail"] as const;
/**
 * Inspection programmes a lane group is reserved for. CBP reports NEXUS and
 * SENTRI members as one queue, so they are one programme here.
 */
export const BORDER_PROGRAMS = ["standard", "fast", "trusted_traveller", "ready_lane"] as const;
export const BORDER_WAIT_STATUSES = ["no_delay", "delay", "closed", "unknown"] as const;

export const borderWaitStatusVocabulary = defineVocabulary({
  code: "border_wait_status",
  values: BORDER_WAIT_STATUSES,
  extensible: false,
  description: "How a border queue is moving, as the inspecting authority states it.",
});

const directionOf = z
  .strictObject({ from: CountryCode, to: CountryCode })
  .refine((d) => d.from !== d.to, { message: "a crossing leads from one country into another" });

/**
 * The border registry module: crossings and their queues. A crossing is one
 * feature for the place; each authority inspects one direction and
 * publishes its own queues, so a queue is a `lane_group` component keyed by
 * mode, programme and direction, and the wait is observed on it.
 */
export const borderModule: RegistryModule = {
  name: "border",
  entries: [
    defineDomain({
      code: DOMAIN,
      description: "Land border crossings and how long their queues are.",
    }),
    borderWaitStatusVocabulary,
    defineKind({
      class: "component",
      code: "lane_group",
      version: V,
      description:
        "The lanes of one inspection queue: one mode, programme, direction and vehicle class.",
      details: () => ({
        mode: z.enum(BORDER_MODES),
        program: z.enum(BORDER_PROGRAMS).optional(),
        direction: directionOf,
        /** The vehicles the queue is for, where a source splits queues by vehicle rather than programme. */
        vehicleClass: z.enum(VEHICLE_CLASSES).optional(),
        lanesTotal: z.number().int().positive().optional(),
      }),
    }),
    defineKind({
      class: "feature",
      code: "border_crossing",
      domain: DOMAIN,
      version: V,
      description: "A road border crossing, with the ports of entry of both countries.",
      components: ["lane_group"],
      traits: ["operated_site"],
      details: (k) => ({
        countries: z.tuple([CountryCode, CountryCode]),
        ports: z
          .array(
            z.strictObject({
              country: CountryCode,
              name: k.Text,
              externalIds: z.array(k.ExternalId).min(1).optional(),
            }),
          )
          .min(1)
          .optional(),
        modes: z.array(z.enum(BORDER_MODES)).min(1),
      }),
      refineDetails: (d, ctx) => {
        const [a, b] = d["countries"] as [string, string];
        if (a === b) {
          ctx.addIssue({
            code: "custom",
            path: ["countries"],
            message: "a crossing joins two countries",
          });
        }
      },
      linking: {
        idSchemes: ["cbp:port", "cbsa:office", "osm:node", "osm:way"],
        alwaysMetres: 200,
        neverMetres: 2000,
        attribute: { name: 0.5 },
        nameStopwords: ["border", "crossing", "port", "of", "entry", "bridge", "grenzübergang"],
        osm: { tags: ["barrier=border_control"] },
      },
    }),
    defineResultSchema({
      code: "border_wait",
      version: V,
      description: "How long one border queue is, and whether it moves.",
      shape: (k) => ({
        status: k.vocab("border_wait_status"),
        /** The wait the authority states; "no delay" may still carry a few minutes. */
        waitMinutes: z.number().nonnegative().optional(),
        lanesOpen: z.number().int().nonnegative().optional(),
        vehiclesInQueue: z.number().int().nonnegative().optional(),
        /** The queue is held: it keeps its wait and length, but nobody is let through. */
        paused: z.boolean().optional(),
      }),
    }),
    defineProperty({
      code: "border.wait",
      domain: DOMAIN,
      version: V,
      description: "The wait in one border queue.",
      result: { type: "structured", schema: "border_wait" },
      subjects: [
        { kind: "feature", featureKinds: ["border_crossing"], componentKinds: ["lane_group"] },
      ],
      freshnessWindowSec: 2 * 3600,
      retention: { rawDays: 30 },
    }),
  ],
};
