import { z } from "zod";
import type { Kernel } from "../kernel/effect-type.js";
import { checkRecordBase, recordBaseShape, type Stage } from "../kernel/record-base.js";
import { Iso8601 } from "../kernel/scalars.js";
import type { KindEntry } from "../registry/define.js";

export const LIFECYCLES = [
  "planned",
  "under_construction",
  "operational",
  "temporarily_closed",
  "decommissioned",
  "unknown",
] as const;
export const PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "debit_card",
  "contactless",
  "app",
  "rfid",
  "sms",
  "membership",
  "direct_debit",
  "free",
  "other",
] as const;
export const AUDIENCES = [
  "public",
  "customers",
  "permit",
  "private",
  "restricted",
  "unknown",
] as const;
export const AUTHENTICATION_METHODS = [
  "none",
  "rfid",
  "app",
  "plug_and_charge",
  "credit_card",
  "debit_card",
  "nfc",
  "qr",
  "remote",
] as const;
export const IMAGE_CATEGORIES = ["site", "entrance", "operator_logo", "sign", "other"] as const;
const OPENING_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU", "PH"] as const;
const LocalTime = z.string().regex(/^(?:[01]\d|2[0-4]):[0-5]\d$/);

export const OpeningHours = z.strictObject({
  /** OSM opening_hours grammar, canonical. */
  osm: z.string().min(1),
  twentyFourSeven: z.boolean().optional(),
  spec: z
    .array(
      z.strictObject({
        days: z.array(z.enum(OPENING_DAYS)).min(1),
        opens: LocalTime,
        closes: LocalTime,
      }),
    )
    .min(1)
    .optional(),
  exceptions: z
    .array(z.strictObject({ start: Iso8601, end: Iso8601, open: z.boolean() }))
    .min(1)
    .optional(),
  chargingWhenClosed: z.boolean().optional(),
  timezone: z.string().min(1).optional(),
});

export function componentSchema(k: Kernel, entry: KindEntry, details: z.ZodType) {
  return z.strictObject({
    /** Source-stable sub-id (EVSE uid, connector id, DATEX parking index…), unique within the feature. */
    key: z.string().min(1),
    parentKey: z.string().min(1).optional(),
    kind: z.literal(entry.code),
    name: k.Text.optional(),
    position: k.PointGeometry.optional(),
    physicalReference: z.string().min(1).optional(),
    floorLevel: z.string().min(1).optional(),
    externalIds: z.array(k.ExternalId).min(1).optional(),
    lifecycle: z.enum(LIFECYCLES).optional(),
    details,
  });
}

export function featureSchema(
  k: Kernel,
  entry: KindEntry,
  details: z.ZodType,
  components: readonly z.ZodType[],
  stage: Stage,
) {
  const types = Object.keys(entry.types ?? {});
  const component =
    components.length === 0
      ? z.never()
      : components.length === 1
        ? components[0]!
        : z.union(components as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  return z
    .strictObject({
      ...recordBaseShape(k, stage),
      class: z.literal("feature"),
      kind: z.literal(entry.code),
      type: types.length > 0 ? z.enum(types as [string, ...string[]]) : z.never().optional(),
      subtype: z.string().min(1).optional(),
      name: k.Text.optional(),
      description: k.Text.optional(),
      lifecycle: z.enum(LIFECYCLES),
      operator: k.Organization.optional(),
      owner: k.Organization.optional(),
      publisher: k.Organization.optional(),
      openingHours: OpeningHours.optional(),
      access: z
        .strictObject({
          audience: z.enum(AUDIENCES),
          payment: z.array(z.enum(PAYMENT_METHODS)).min(1).optional(),
          authentication: z.array(z.enum(AUTHENTICATION_METHODS)).min(1).optional(),
          capabilities: z.array(z.string().min(1)).min(1).optional(),
          reservation: z.boolean().optional(),
          notes: k.Text.optional(),
        })
        .optional(),
      amenities: z.array(k.vocab("amenity")).min(1).optional(),
      images: z
        .array(
          z.strictObject({
            url: z.url(),
            category: z.enum(IMAGE_CATEGORIES),
            thumbnail: z.url().optional(),
          }),
        )
        .min(1)
        .optional(),
      components: z.array(component).min(1).optional(),
      details,
      osmMatch: z
        .strictObject({
          id: k.ExternalId,
          method: z.enum(["id", "spatial_tag"]),
          confidence: z.number().min(0).max(1),
        })
        .optional(),
    })
    .superRefine((f, ctx) => {
      checkRecordBase(f, "feature", entry.domain, ctx);
      const partOf = (f.relations ?? []).flatMap((r, i) => (r.relation === "part_of" ? [i] : []));
      if (partOf.length > 1) {
        ctx.addIssue({
          code: "custom",
          path: ["relations", partOf[1]!],
          message: "a feature is part of at most one feature",
        });
      }
      for (const i of partOf) {
        const ref = f.relations![i]!.ref;
        if (ref.class !== "feature" || ref.componentKey !== undefined || ref.id === f.id) {
          ctx.addIssue({
            code: "custom",
            path: ["relations", i, "ref"],
            message: "part_of names another whole feature",
          });
        }
      }
      if (
        f.subtype !== undefined &&
        (f.type === undefined || !(entry.types?.[f.type] ?? []).includes(f.subtype))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["subtype"],
          message: `subtype "${f.subtype}" is not registered`,
        });
      }
      const list = (f.components ?? []) as { key: string; parentKey?: string }[];
      const byKey = new Map(list.map((c) => [c.key, c]));
      if (byKey.size !== list.length) {
        ctx.addIssue({
          code: "custom",
          path: ["components"],
          message: "component keys are unique within a feature",
        });
      }
      list.forEach((c, i) => {
        if (c.parentKey === undefined) return;
        const parent = byKey.get(c.parentKey);
        if (parent === undefined || parent.parentKey !== undefined || c.parentKey === c.key) {
          ctx.addIssue({
            code: "custom",
            path: ["components", i, "parentKey"],
            message:
              "parentKey names a top-level component of the same feature (one level of nesting)",
          });
        }
      });
    });
}
