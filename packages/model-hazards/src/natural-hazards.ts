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
 * the area it burnt, a smoke plume, a flood, an earthquake. A warning an
 * authority issues as a CAP message is an `alert`; a register that lists the
 * places where flooding is possible or expected, without CAP, states the
 * hazard with the situation's certainty.
 */
export const naturalHazardKind = defineKind({
  class: "situation",
  code: "natural_hazard",
  domain: DOMAIN,
  version: V,
  description:
    "A natural hazard event from an authority or a satellite: wildfire, flood, smoke, landslide, avalanche, earthquake, volcanic ash, dust storm.",
  types: {
    wildfire: ["wildfire_perimeter", "hotspot_cluster", "burned_area", "prescribed_burn"],
    flood: ["river", "flash", "coastal"],
    smoke: [],
    landslide: [],
    avalanche: [],
    earthquake: [],
    volcanic_ash: [],
    dust_storm: [],
  },
  details: (k) => ({
    name: k.Text.optional(),
    areaHa: z.number().nonnegative().optional(),
    containmentPct: z.number().min(0).max(100).optional(),
    discoveredAt: Iso8601.optional(),
    ignitionCause: z.enum(IGNITION_CAUSES).optional(),
    density: z.enum(SMOKE_DENSITIES).optional(),
    detection: z
      .strictObject({
        satellite: z.string().min(1).optional(),
        confidence: z.string().min(1).optional(),
      })
      .optional(),
    /** An earthquake's magnitude on the scale the network names (`mww`, `mb`, `ml`). */
    magnitude: z.strictObject({ value: z.number(), scale: z.string().min(1) }).optional(),
    /** Hypocentre depth below the surface; GeoJSON has no axis for it. */
    depth: quantityIn("m").optional(),
    /** The river, estuary or sea a flood comes from. */
    waterBody: z.string().min(1).optional(),
  }),
});

/**
 * A radiated power or an absolute temperature below zero is no reading; it
 * is refused rather than stored, as an impossible count is.
 */
function nonNegative(observation: Record<string, unknown>, ctx: z.RefinementCtx) {
  const result = observation["result"] as { type: string; value?: number };
  if (result.type === "quantity" && (result.value ?? 0) < 0) {
    ctx.addIssue({ code: "custom", path: ["result", "value"], message: "must not be negative" });
  }
}

/**
 * Satellite fire detections: one observation per fire pixel, located at the
 * pixel. The brightness is the mid-infrared channel's (VIIRS I4, MODIS
 * 21/22); the thermal channel only describes the background.
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
    retention: { rawDays: 7 },
  }),
  defineProperty({
    code: "fire.brightness",
    domain: DOMAIN,
    version: V,
    description: "Mid-infrared brightness temperature of one satellite fire pixel.",
    result: { type: "quantity", unit: "K" },
    subjects: [{ kind: "location" }],
    refine: nonNegative,
    freshnessWindowSec: 43200,
    retention: { rawDays: 7 },
  }),
];
