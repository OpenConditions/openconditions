import { defineKind, quantityIn } from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "roads";
const V = "1.0";
const Metres = quantityIn("m");
const Kilograms = quantityIn("kg");
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * How a clearance was obtained. Registers publish several for one opening:
 * the Norwegian road database keeps the measured minimum at the left edge,
 * the middle and the right edge, a calculated height (measured minus a
 * safety margin) and the signed height, and they differ by up to 0.6 m.
 */
export const CLEARANCE_BASES = ["measured", "calculated", "signed", "design"] as const;

/** Warning devices at a level crossing, as the US crossing inventory counts them. */
export const RAIL_CROSSING_WARNINGS = [
  "flashing_lights",
  "bells",
  "traffic_signal",
  "horn",
  "crossbucks",
  "stop_sign",
  "yield_sign",
] as const;

const clearance = z.strictObject({
  /**
   * `carried`: the road on or through the structure (a tunnel bore, a
   * through-truss deck); `crossed`: the road passing under it.
   */
  road: z.enum(["carried", "crossed"]),
  height: Metres,
  basis: z.enum(CLEARANCE_BASES),
  /** Where across the opening a measurement was taken; absent for the opening's minimum. */
  position: z.enum(["left", "centre", "right"]).optional(),
});

/**
 * Road structures and the fixed things along a road that are features
 * rather than events: bridges and tunnels with their clearances, level
 * crossings, accident blackspots, emergency telephones, lane-control
 * gantries.
 */
export const ROADS_NETWORK_KINDS = [
  defineKind({
    class: "feature",
    code: "structure",
    domain: DOMAIN,
    version: V,
    description: "A bridge, tunnel, overpass, underpass, culvert or gantry and its limits.",
    types: {
      bridge: [],
      tunnel: [],
      overpass: [],
      underpass: [],
      culvert: [],
      gantry: [],
    },
    details: () => ({
      /** The road on the structure and the feature under it, as the register names them. */
      carries: z.string().min(1).optional(),
      crosses: z.string().min(1).optional(),
      length: Metres.optional(),
      width: Metres.optional(),
      yearBuilt: z.number().int().min(1000).max(9999).optional(),
      clearances: z.array(clearance).min(1).optional(),
      /** Legal limits posted for the structure, in the dimension's canonical unit. */
      weightLimit: Kilograms.optional(),
      axleLimit: Kilograms.optional(),
      widthLimit: Metres.optional(),
      /** A national load class the structure is rated for, verbatim (Norway: "Bk 10/60"). */
      loadClass: z.string().min(1).optional(),
      adrTunnelCategory: z.enum(["A", "B", "C", "D", "E"]).optional(),
      /**
       * The US National Bridge Inventory's own codes: item 41 (open, posted
       * or closed), item 70 (how far the rated load falls below the legal
       * load, 0–5) and the condition ratings of items 58–62 (0–9, N).
       */
      nbi: z
        .strictObject({
          structureNumber: z.string().min(1),
          stateCode: z.string().regex(/^\d{2}$/),
          openStatus: z.enum(["A", "B", "D", "E", "G", "K", "P", "R"]),
          postingEvaluation: z.enum(["0", "1", "2", "3", "4", "5"]).optional(),
          conditions: z
            .strictObject({
              deck: z
                .string()
                .regex(/^[0-9N]$/)
                .optional(),
              superstructure: z
                .string()
                .regex(/^[0-9N]$/)
                .optional(),
              substructure: z
                .string()
                .regex(/^[0-9N]$/)
                .optional(),
              culvert: z
                .string()
                .regex(/^[0-9N]$/)
                .optional(),
            })
            .optional(),
        })
        .optional(),
    }),
    linking: {
      idSchemes: ["nbi:structure", "osm:way"],
      alwaysMetres: 15,
      neverMetres: 60,
      attribute: { name: 0.6 },
      nameStopwords: ["bridge", "bru", "brua", "brücke", "tunnel", "tunnelen", "over", "under"],
      osm: { tags: ["bridge=yes", "tunnel=yes"] },
    },
  }),
  defineKind({
    class: "feature",
    code: "rail_crossing",
    domain: DOMAIN,
    version: V,
    description: "Where a road crosses a railway, at grade or over or under it.",
    details: () => ({
      /** `road_over` / `road_under`: grade-separated crossings, which both registers list too. */
      position: z.enum(["at_grade", "road_over", "road_under"]),
      /** Full barriers close the whole road, half barriers the entry lanes, gates are swing gates. */
      barrier: z.enum(["full", "half", "gate", "none", "unknown"]).optional(),
      /** Active and passive warning devices; absent = the source does not say. */
      warnings: z.array(z.enum(RAIL_CROSSING_WARNINGS)).min(1).optional(),
      tracks: z.number().int().positive().optional(),
      /** The crossing is humped: long, low vehicles can ground on the track. */
      humped: z.boolean().optional(),
      usage: z.enum(["road", "pedestrian"]).optional(),
    }),
    linking: {
      idSchemes: ["fra:crossing", "osm:node"],
      alwaysMetres: 15,
      neverMetres: 60,
      attribute: { name: 0.6 },
      osm: { tags: ["railway=level_crossing", "railway=crossing"] },
    },
  }),
  defineKind({
    class: "feature",
    code: "blackspot",
    domain: DOMAIN,
    version: V,
    description:
      "A road section or point where accidents concentrate, from an authority's analysis.",
    details: () => ({
      /** The analysed period, local dates, both included. */
      period: z.strictObject({ from: LocalDate, to: LocalDate }),
      /** Accidents counted in the period. */
      accidents: z.number().int().nonnegative(),
      /**
       * The same accidents split by their worst outcome. Registers count
       * accidents, never the people hurt in them.
       */
      bySeverity: z
        .strictObject({
          fatal: z.number().int().nonnegative().optional(),
          serious: z.number().int().nonnegative().optional(),
          slight: z.number().int().nonnegative().optional(),
          injury: z.number().int().nonnegative().optional(),
          damageOnly: z.number().int().nonnegative().optional(),
        })
        .optional(),
      /** A rate the register computes, with its basis in the register's words. */
      rate: z
        .strictObject({ value: z.number().nonnegative(), basis: z.string().min(1) })
        .optional(),
      /** The register's own classification of the site, verbatim ("Twice Above Average Rate"). */
      band: z.string().min(1).optional(),
      method: z.string().min(1).optional(),
    }),
  }),
  defineKind({
    class: "feature",
    code: "emergency_phone",
    domain: DOMAIN,
    version: V,
    description: "A roadside emergency telephone.",
    details: () => ({}),
  }),
  defineKind({
    class: "feature",
    code: "lane_control_gantry",
    domain: DOMAIN,
    version: V,
    description: "A gantry of lane-control signals over a carriageway.",
    traits: ["field_device"],
    details: () => ({}),
  }),
];
