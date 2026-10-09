import { defineKind, defineProperty, Iso8601, quantityIn } from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "hazards";
const V = "1.0";

/** How a wildfire started, as incident registers record it once investigated. */
export const IGNITION_CAUSES = ["natural", "human", "undetermined"] as const;
/** Satellite smoke analysts grade a plume by how much it hides the ground. */
export const SMOKE_DENSITIES = ["light", "medium", "heavy"] as const;

/**
 * A hazard event itself rather than a warning about it: a fire's perimeter,
 * the area it burnt, a smoke plume, a flood, an earthquake, a storm, an
 * eruption. A warning an authority issues as a CAP message is an `alert`; a
 * register that lists the places where flooding is possible or expected,
 * without CAP, states the hazard with the situation's certainty.
 */
export const naturalHazardKind = defineKind({
  class: "situation",
  code: "natural_hazard",
  domain: DOMAIN,
  version: V,
  description:
    "A natural hazard event from an authority or a satellite: wildfire, flood, smoke, landslide, avalanche, earthquake, volcanic ash, dust storm, tropical cyclone, volcano, drought, sea ice.",
  types: {
    wildfire: ["wildfire_perimeter", "hotspot_cluster", "burned_area", "prescribed_burn"],
    flood: ["river", "flash", "coastal"],
    smoke: [],
    landslide: [],
    avalanche: [],
    earthquake: [],
    volcanic_ash: [],
    dust_storm: [],
    tropical_cyclone: ["tropical_depression", "tropical_storm", "hurricane", "typhoon", "cyclone"],
    volcano: [],
    drought: [],
    sea_ice: ["iceberg", "lake_ice"],
  },
  details: (k) => ({
    name: k.Text.optional(),
    /** The publisher's own page for this event. */
    detailUrl: z.url().optional(),
    areaHa: z.number().nonnegative().optional(),
    containmentPct: z.number().min(0).max(100).optional(),
    discoveredAt: Iso8601.optional(),
    /** When the fire's current perimeter was mapped. */
    perimeterAt: Iso8601.optional(),
    ignitionCause: z.enum(IGNITION_CAUSES).optional(),
    density: z.enum(SMOKE_DENSITIES).optional(),
    /**
     * The satellite pass or image sequence a detection comes from; a smoke
     * analysis covers a window of images, and the plume outlives it.
     */
    detection: z
      .strictObject({
        satellite: z.string().min(1).optional(),
        confidence: z.string().min(1).optional(),
        start: Iso8601.optional(),
        end: Iso8601.optional(),
      })
      .optional(),
    /** An earthquake's magnitude on the scale the network names (`mww`, `mb`, `ml`). */
    magnitude: z.strictObject({ value: z.number(), scale: z.string().min(1) }).optional(),
    /**
     * Hypocentre depth in metres below the surface, which GeoJSON has no
     * axis for; negative above sea level, as networks place shallow events
     * under high ground.
     */
    depth: z
      .strictObject({
        value: z.number(),
        unit: z.literal("m"),
        accuracy: z.number().nonnegative().optional(),
      })
      .optional(),
    /**
     * USGS's flag for a large event in an oceanic region, where a tsunami is
     * possible; it is not a tsunami warning.
     */
    tsunamiFlag: z.boolean().optional(),
    /** How many people reported feeling the event. */
    feltReports: z.number().int().nonnegative().optional(),
    /** The highest Modified Mercalli intensity estimated for the event. */
    mmi: z.number().min(0).max(12).optional(),
    /** Whether a seismologist has reviewed the automatic solution. */
    reviewed: z.boolean().optional(),
    /** A storm's highest sustained wind. */
    maxWind: quantityIn("km/h").optional(),
    /** How many people live in the area the publisher estimates is affected. */
    populationAffected: z.number().int().nonnegative().optional(),
    /** The river, estuary or sea a flood comes from. */
    waterBody: z.string().min(1).optional(),
  }),
});

/**
 * A radiated power below zero is no reading; it is refused rather than
 * stored, as an impossible count is.
 */
function nonNegative(observation: Record<string, unknown>, ctx: z.RefinementCtx) {
  const result = observation["result"] as { type: string; value?: number };
  if (result.type === "quantity" && (result.value ?? 0) < 0) {
    ctx.addIssue({ code: "custom", path: ["result", "value"], message: "must not be negative" });
  }
}

/**
 * Satellite fire detections: one observation per fire pixel, located at the
 * pixel. Each detection is a reading of one pass that is never revised, so
 * its series is transient; the pixel's brightness temperatures travel as the
 * reading's extras.
 */
export const FIRE_PROPERTIES = [
  defineProperty({
    code: "fire.frp",
    domain: DOMAIN,
    version: V,
    description: "Fire radiative power of one satellite fire pixel.",
    result: { type: "quantity", unit: "MW" },
    subjects: [{ kind: "location" }],
    refine: nonNegative,
    freshnessWindowSec: 43200,
    transient: true,
    retention: { rawDays: 7 },
  }),
];
