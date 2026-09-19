import { z } from "zod";
import type { Kernel } from "../kernel/effect-type.js";
import { checkRecordBase, recordBaseShape, type Stage } from "../kernel/record-base.js";
import { CurrencyCode, Quantity, UcumUnit } from "../kernel/scalars.js";
import type { KindEntry } from "../registry/define.js";

export const PRICE_COMPONENT_TYPES = [
  "energy",
  "time",
  "flat",
  "parking_time",
  "session",
  "distance",
  "idle",
  "reservation",
] as const;
export const TARIFF_TYPES = [
  "ad_hoc",
  "profile_cheap",
  "profile_fast",
  "profile_green",
  "regular",
  "member",
  "roaming",
] as const;
const WEEK_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const LocalTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function offerSchema(k: Kernel, entry: KindEntry, stage: Stage) {
  const PriceComponent = z.strictObject({
    type: z.enum(PRICE_COMPONENT_TYPES),
    price: k.Money,
    vatPct: z.number().min(0).max(100).optional(),
    stepSize: z.number().int().positive().optional(),
    unit: UcumUnit.optional(),
  });
  const PriceRestriction = z.strictObject({
    startTime: LocalTime.optional(),
    endTime: LocalTime.optional(),
    startDate: LocalDate.optional(),
    endDate: LocalDate.optional(),
    days: z.array(z.enum(WEEK_DAYS)).min(1).optional(),
    minKwh: z.number().nonnegative().optional(),
    maxKwh: z.number().nonnegative().optional(),
    minCurrentA: z.number().nonnegative().optional(),
    maxCurrentA: z.number().nonnegative().optional(),
    minPowerKw: z.number().nonnegative().optional(),
    maxPowerKw: z.number().nonnegative().optional(),
    minDuration: Quantity.optional(),
    maxDuration: Quantity.optional(),
    reservation: z.enum(["reservation", "reservation_expires"]).optional(),
    vehicle: k.VehicleApplicability.optional(),
    userGroups: z.array(z.string().min(1)).min(1).optional(),
  });
  const EnergyMix = z.strictObject({
    isGreen: z.boolean().optional(),
    supplierName: z.string().min(1).optional(),
    sources: z
      .array(z.strictObject({ source: z.string().min(1), pct: z.number().min(0).max(100) }))
      .min(1)
      .optional(),
  });
  return z
    .strictObject({
      ...recordBaseShape(k, stage),
      class: z.literal("offer"),
      kind: z.literal(entry.code),
      /** A feature or one of its components (connector, parking_area, toll_section, ferry_leg). */
      subject: k.RecordRef,
      /** Every Money inside elements/minPrice/maxPrice carries this currency; mixed currencies = separate offers. */
      currency: CurrencyCode,
      tariffType: z.enum(TARIFF_TYPES).optional(),
      scope: z.enum(["evse", "cpo", "country"]).optional(),
      elements: z
        .array(
          z.strictObject({
            components: z.array(PriceComponent).min(1),
            restrictions: PriceRestriction.optional(),
          }),
        )
        .min(1),
      minPrice: k.Money.optional(),
      maxPrice: k.Money.optional(),
      priceIncludesVat: z.boolean().optional(),
      altText: k.Text.optional(),
      url: z.url().optional(),
      validity: k.Validity,
      applicability: k.VehicleApplicability.optional(),
      energyMix: EnergyMix.optional(),
      /** Non-decomposable source rows kept verbatim. */
      displayText: k.Text.optional(),
    })
    .superRefine((o, ctx) => {
      checkRecordBase(o, "offer", entry.domain, ctx);
      if (o.subject.class !== "feature") {
        ctx.addIssue({
          code: "custom",
          path: ["subject", "class"],
          message: "an offer's subject is a feature or component",
        });
      }
      const monies: [(string | number)[], { currency: string }][] = [];
      o.elements.forEach((el, i) => {
        el.components.forEach((c, j) => {
          monies.push([["elements", i, "components", j, "price"], c.price]);
        });
      });
      if (o.minPrice) monies.push([["minPrice"], o.minPrice]);
      if (o.maxPrice) monies.push([["maxPrice"], o.maxPrice]);
      for (const [path, money] of monies) {
        if (money.currency !== o.currency) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "currency"],
            message: `offer currency is ${o.currency}`,
          });
        }
      }
    });
}
