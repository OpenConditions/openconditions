import { z } from "zod";
import { Quantity } from "./scalars.js";
import type { Vocab } from "./vocab.js";

export const VEHICLE_CLASSES = [
  "motor_vehicle",
  "car",
  "van",
  "truck",
  "hgv",
  "bus",
  "coach",
  "motorcycle",
  "moped",
  "bicycle",
  "pedestrian",
  "trailer",
  "caravan",
  "agricultural",
  "emergency",
  "taxi",
  "oversize",
  "abnormal_load",
] as const;
export const DIMENSIONS = [
  "height",
  "width",
  "length",
  "gross_weight",
  "laden_weight",
  "axle_load",
  "axle_count",
  "trailer_count",
] as const;
export const VEHICLE_USAGES = [
  "emergency_services",
  "public_transport",
  "taxi",
  "delivery",
  "residents",
  "permit_holders",
  "military",
  "agricultural",
  "car_sharing",
] as const;
export const VEHICLE_FUELS = [
  "electric",
  "hydrogen",
  "lpg",
  "cng",
  "lng",
  "diesel",
  "petrol",
  "hybrid",
] as const;
export const COMPARISON_OPERATORS = ["lt", "lte", "eq", "gte", "gt"] as const;
export const ADR_TUNNEL_CATEGORIES = ["A", "B", "C", "D", "E"] as const;
export const APPLICABILITY_KINDS = ["all", "classes", "unknown"] as const;

export type VehicleClass = (typeof VEHICLE_CLASSES)[number];
export type Dimension = (typeof DIMENSIONS)[number];

/** The one canonical unit per dimension; ingest converts (t → kg, ft → m). */
export const DIMENSION_UNITS: Record<Dimension, string> = {
  height: "m",
  width: "m",
  length: "m",
  gross_weight: "kg",
  laden_weight: "kg",
  axle_load: "kg",
  axle_count: "1",
  trailer_count: "1",
};

/** Adds an issue when `value.unit` is not the canonical unit of `dimension`. */
export function checkDimensionUnit(
  dimension: Dimension,
  value: { unit: string },
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  const want = DIMENSION_UNITS[dimension];
  if (value.unit !== want) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `${dimension} is expressed in "${want}", not "${value.unit}"`,
    });
  }
}

export function vehicleSchemas(vocab: Vocab) {
  const VehicleSelector = z
    .strictObject({
      class: z.enum(VEHICLE_CLASSES).optional(),
      usage: z.enum(VEHICLE_USAGES).optional(),
      fuel: z.enum(VEHICLE_FUELS).optional(),
      emission: z
        .strictObject({
          scheme: vocab("emission_scheme"),
          values: z.array(z.string().min(1)).min(1),
        })
        .optional(),
      /** "trucks > 7.5 t" = { dimension: "gross_weight", operator: "gt", value: 7500 kg }. */
      when: z
        .array(
          z.strictObject({
            dimension: z.enum(DIMENSIONS),
            operator: z.enum(COMPARISON_OPERATORS),
            value: Quantity,
          }),
        )
        .min(1)
        .optional(),
      hazmat: z
        .strictObject({
          adrTunnelCategory: z.enum(ADR_TUNNEL_CATEGORIES).optional(),
          unClasses: z.array(z.string().min(1)).min(1).optional(),
          placarded: z.boolean().optional(),
        })
        .optional(),
      hovMin: z.number().int().min(2).optional(),
      raw: z.array(z.string().min(1)).min(1).optional(),
    })
    .superRefine((s, ctx) => {
      s.when?.forEach((w, i) => {
        checkDimensionUnit(w.dimension, w.value, ctx, ["when", i, "value", "unit"]);
      });
      const constrained = Object.keys(s).some((key) => key !== "raw");
      if (!constrained) {
        ctx.addIssue({ code: "custom", message: "a selector constrains at least one field" });
      }
    });

  /**
   * "all": every vehicle, optionally minus `except`. "classes": `include`
   * required (selectors OR-ed, fields inside one selector AND-ed), minus
   * `except`. "unknown": the source restricts some vehicles but the parser
   * could not say which — restriction evidence.
   */
  const VehicleApplicability = z
    .strictObject({
      kind: z.enum(APPLICABILITY_KINDS),
      include: z.array(VehicleSelector).min(1).optional(),
      except: z.array(VehicleSelector).min(1).optional(),
      raw: z.array(z.string().min(1)).min(1).optional(),
    })
    .superRefine((a, ctx) => {
      if (a.kind === "classes" && a.include === undefined) {
        ctx.addIssue({ code: "custom", path: ["include"], message: '"classes" requires include' });
      }
      if (a.kind !== "classes" && a.include !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["include"],
          message: `include belongs to "classes", not "${a.kind}"`,
        });
      }
    });

  return { VehicleSelector, VehicleApplicability };
}
