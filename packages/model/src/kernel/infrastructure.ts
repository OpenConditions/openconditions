import { z } from "zod";
import { defineKind, defineVocabulary } from "../registry/define.js";

/**
 * Road surface states: what a surface sensor measures (`road.surface_state`)
 * and what a road-condition situation reports. Shared by the roads and
 * weather modules, so it lives in the kernel.
 */
export const SURFACE_STATES = [
  "dry",
  "damp",
  "wet",
  "frost",
  "ice",
  "black_ice",
  "snow",
  "packed_snow",
  "slush",
  "standing_water",
  "flooded",
  "chemically_wet",
  "unknown",
] as const;

/**
 * Traits a feature kind can carry, so a property names a capability rather
 * than every kind of every module that has it:
 * - `field_device`: roadside equipment that reports its own operating state
 *   (`device.status`);
 * - `weather_sensing`: a site that can measure weather and road-surface
 *   values (a weather station, or a traffic site that also measures weather).
 */
export const FEATURE_TRAITS = ["field_device", "weather_sensing"] as const;

export const surfaceStateVocabulary = defineVocabulary({
  code: "surface_state",
  values: SURFACE_STATES,
  extensible: false,
  description: "Road surface states.",
});

export const featureTraitVocabulary = defineVocabulary({
  code: "feature_trait",
  values: FEATURE_TRAITS,
  extensible: true,
  description: "Capabilities a feature kind declares; properties name them as subjects.",
});

/**
 * One measured value stream of a site: a DATEX measurement-site index, a
 * detector loop's speed channel, a road-weather station's second surface
 * sensor. Traffic measurement sites and weather stations both carry them, so
 * the component kind is the kernel's.
 */
export const sensorChannelKind = defineKind({
  class: "component",
  code: "sensor_channel",
  version: "1.0",
  description:
    "One measured value stream of a site: the property it measures, and the lane, direction and vehicle class it covers.",
  details: (k) => ({
    /** The source's index of the stream within its site (DATEX `index`), when it numbers them. */
    index: z.number().int().nonnegative().optional(),
    lane: k.LaneRef.optional(),
    direction: k.DirectionRef.optional(),
    vehicleClass: z.union([k.vocab("vehicle_class"), z.literal("any")]).optional(),
    /** The registered property this stream reports. */
    property: z.string().min(1),
  }),
});
