import { z } from "zod";
import { defineEffect } from "../registry/define.js";
import type { locationSchemas } from "./location.js";
import { DirectionRef, LaneRef } from "./location.js";
import { Geometry, Quantity, Text } from "./scalars.js";
import { Validity } from "./validity.js";
import type { vehicleSchemas } from "./vehicle.js";
import { ADR_TUNNEL_CATEGORIES, checkDimensionUnit, DIMENSIONS } from "./vehicle.js";
import type { Vocab } from "./vocab.js";

export const COMPLIANCE = ["mandatory", "advisory", "unknown"] as const;
export const NORMALIZATION = ["complete", "partial", "unsupported"] as const;
export const LOS = [
  "free_flow",
  "slow",
  "heavy",
  "queuing",
  "stationary",
  "blocked",
  "unknown",
] as const;
/** DATEX OperatorActionStatus, snake_cased. requested/rejected/termination_requested never route. */
export const ACTION_STATUSES = [
  "requested",
  "approved",
  "being_implemented",
  "implemented",
  "rejected",
  "termination_requested",
  "being_terminated",
] as const;
export const CORE_ISSUE_CODES = [
  "unsupported_type",
  "unsupported_unit",
  "unsupported_operator",
  "invalid_value",
  "invalid_window",
  "unsupported_schedule",
  "unsupported_status",
  "unknown_vehicle",
  "compound_condition",
  "conflicting_direction",
  "unresolved_lane",
] as const;

export function issueSchema(vocab: Vocab) {
  return z.strictObject({
    code: vocab("issue_code"),
    sourcePath: z.string().min(1),
    sourceText: z.string().min(1).optional(),
    sourceTokens: z.record(z.string(), z.unknown()).optional(),
    truncated: z.literal(true).optional(),
  });
}

/** Fields every effect carries; each registered variant adds `kind`, `v` and its own fields. */
export function effectBaseShape(
  vocab: Vocab,
  loc: ReturnType<typeof locationSchemas>,
  vehicle: ReturnType<typeof vehicleSchemas>,
) {
  return {
    /** Stable across revisions: `<source record id>/<kind>[:<n>]`, else `<kind>:<n>`. */
    id: z.string().min(1),
    /** DATEX situationRecord id/version this effect was read from. */
    sourceRecordRef: z.string().min(1).optional(),
    /** Override when this effect's extent differs from the situation's; bound separately. */
    location: loc.PartialLocationRef.optional(),
    applicability: vehicle.VehicleApplicability,
    /** Absent = not directional; `{value: "unknown"}` = directional but unparsed. */
    direction: DirectionRef.optional(),
    laneScope: z.array(LaneRef).min(1).optional(),
    /** Defaults to the situation's. */
    validity: Validity.optional(),
    compliance: z.enum(COMPLIANCE),
    normalization: z.enum(NORMALIZATION),
    actionStatus: z.enum(ACTION_STATUSES).optional(),
    issues: z.array(issueSchema(vocab)).min(1).optional(),
    source: z
      .strictObject({
        path: z.string().min(1),
        tokens: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  };
}

const LANE_STATUSES = [
  "open",
  "closed",
  "alternating",
  "shift_left",
  "shift_right",
  "merge_left",
  "merge_right",
  "narrowed",
  "contraflow",
] as const;
const VEHICLE_IMPACTS = [
  "all_lanes_closed",
  "some_lanes_closed",
  "all_lanes_open",
  "alternating_one_way",
  "some_lanes_closed_merge_left",
  "some_lanes_closed_merge_right",
  "all_lanes_open_shift_left",
  "all_lanes_open_shift_right",
  "some_lanes_closed_split",
  "flagging",
  "temporary_traffic_signal",
  "unknown",
] as const;
const ACCESS_RULES = [
  "prohibited",
  "local_access_only",
  "permit_only",
  "escort_required",
  "chains_required",
  "chains_or_winter_tyres_required",
  "winter_tyres_required",
  "chains_recommended",
  "no_overtaking",
  "no_parking",
  "no_stopping",
  "towing_prohibited",
  "oversize_prohibited",
  "convoy",
] as const;

function unitIs(
  q: { unit: string } | undefined,
  unit: string,
  path: string,
  ctx: z.RefinementCtx,
): void {
  if (q !== undefined && q.unit !== unit) {
    ctx.addIssue({ code: "custom", path: [path, "unit"], message: `${path} is in "${unit}"` });
  }
}

/** The effect variants the kernel ships; domain packages add their own via `defineEffect`. */
export const KERNEL_EFFECTS = [
  defineEffect({
    code: "closure",
    version: "1.0",
    description:
      "The road element is closed. Individual lanes or the hard shoulder closed = lane_restriction, never a closure.",
    shape: () => ({
      scope: z.enum([
        "road",
        "carriageway",
        "ramp",
        "junction",
        "bridge",
        "tunnel",
        "sidewalk",
        "cycleway",
        "rest_area",
        "facility",
      ]),
    }),
  }),
  defineEffect({
    code: "lane_restriction",
    version: "1.0",
    description: "Lane-level impact (WZDx VehicleImpact, snake_cased).",
    shape: () => ({
      lanesTotal: z.number().int().positive().optional(),
      lanesClosed: z.number().int().nonnegative().optional(),
      lanes: z
        .array(z.strictObject({ ...LaneRef.shape, status: z.enum(LANE_STATUSES) }))
        .min(1)
        .optional(),
      vehicleImpact: z.enum(VEHICLE_IMPACTS),
    }),
    refine: (e, ctx) => {
      const total = e["lanesTotal"] as number | undefined;
      const closed = e["lanesClosed"] as number | undefined;
      if (total !== undefined && closed !== undefined && closed > total) {
        ctx.addIssue({
          code: "custom",
          path: ["lanesClosed"],
          message: "more lanes closed than exist",
        });
      }
    },
  }),
  defineEffect({
    code: "speed_limit",
    version: "1.0",
    description: "A (temporary) speed limit in km/h.",
    shape: () => ({
      limit: Quantity,
      advisory: z.boolean().optional(),
      /** Derived from a VMS display. */
      displayed: z.boolean().optional(),
    }),
    refine: (e, ctx) => unitIs(e["limit"] as { unit: string }, "km/h", "limit", ctx),
  }),
  defineEffect({
    code: "delay",
    version: "1.0",
    description: "Expected delay, queue and level of service.",
    shape: () => ({
      delay: Quantity.optional(),
      queueLength: Quantity.optional(),
      los: z.enum(LOS).optional(),
      capacityRemainingPct: z.number().min(0).max(100).optional(),
    }),
    refine: (e, ctx) => {
      unitIs(e["delay"] as { unit: string } | undefined, "s", "delay", ctx);
      unitIs(e["queueLength"] as { unit: string } | undefined, "m", "queueLength", ctx);
    },
  }),
  defineEffect({
    code: "access",
    version: "1.0",
    description: "An access rule for the vehicles in `applicability`.",
    shape: () => ({
      mode: z.enum(ACCESS_RULES),
      chainLevel: z.enum(["R1", "R2", "R3"]).optional(),
    }),
  }),
  defineEffect({
    code: "dimension_limit",
    version: "1.0",
    description: "A maximum permitted vehicle dimension, in the dimension's canonical unit.",
    shape: () => ({
      dimension: z.enum(DIMENSIONS),
      value: Quantity,
      operator: z.enum(["lt", "lte"]),
      meaning: z.literal("maximum_permitted"),
    }),
    refine: (e, ctx) =>
      checkDimensionUnit(
        e["dimension"] as (typeof DIMENSIONS)[number],
        e["value"] as { unit: string },
        ctx,
        ["value", "unit"],
      ),
  }),
  defineEffect({
    code: "hazmat",
    version: "1.0",
    description:
      "Dangerous-goods restriction. ADR tunnel category A means no restriction and is never an effect.",
    shape: () => ({
      mode: z.enum(["prohibited", "restricted"]),
      adrTunnelCategory: z
        .enum(ADR_TUNNEL_CATEGORIES.filter((c) => c !== "A") as ["B", "C", "D", "E"])
        .optional(),
      unClasses: z.array(z.string().min(1)).min(1).optional(),
    }),
  }),
  defineEffect({
    code: "detour",
    version: "1.0",
    description: "A signed or described diversion.",
    shape: (k) => ({
      description: Text.optional(),
      geometry: Geometry.optional(),
      signed: z.boolean().optional(),
      via: z.array(k.RoadRef).min(1).optional(),
    }),
    refine: (e, ctx) => {
      const g = e["geometry"] as { type: string } | undefined;
      if (g !== undefined && g.type !== "LineString" && g.type !== "MultiLineString") {
        ctx.addIssue({
          code: "custom",
          path: ["geometry"],
          message: "a detour geometry is a (Multi)LineString",
        });
      }
    },
  }),
  defineEffect({
    code: "contraflow",
    version: "1.0",
    description: "Traffic runs against the normal direction on part of the carriageway.",
    shape: () => ({}),
  }),
  defineEffect({
    code: "advisory",
    version: "1.0",
    description: "Advice without a typed rule.",
    shape: () => ({ text: Text }),
  }),
  defineEffect({
    code: "unsupported",
    version: "1.0",
    description:
      "Carrier for a source restriction the parser recognised but could not type; always normalization unsupported with issues.",
    shape: () => ({ summary: Text.optional() }),
    refine: (e, ctx) => {
      if (e["normalization"] !== "unsupported") {
        ctx.addIssue({
          code: "custom",
          path: ["normalization"],
          message: 'unsupported effects have normalization "unsupported"',
        });
      }
      if (e["issues"] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["issues"],
          message: "unsupported effects carry issues",
        });
      }
    },
  }),
] as const;
