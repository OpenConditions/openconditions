import { z } from "zod";
import { CurrencyCode, DecimalString, Text, UcumUnit } from "./scalars.js";

export const RESULT_TYPES = [
  "quantity",
  "count",
  "boolean",
  "category",
  "text",
  "vector",
  "money",
  "structured",
  "unknown",
  "not_applicable",
] as const;

export const QuantityResult = z.strictObject({
  type: z.literal("quantity"),
  value: z.number(),
  unit: UcumUnit,
  accuracy: z.number().nonnegative().optional(),
});
export const CountResult = z.strictObject({
  type: z.literal("count"),
  value: z.number().int().nonnegative(),
});
export const BooleanResult = z.strictObject({ type: z.literal("boolean"), value: z.boolean() });
export const CategoryResult = z.strictObject({
  type: z.literal("category"),
  value: z.string().min(1),
  vocabulary: z.string().min(1),
});
export const TextResult = z.strictObject({ type: z.literal("text"), value: Text });
export const VectorResult = z.strictObject({
  type: z.literal("vector"),
  values: z.record(z.string(), z.number()),
  unit: UcumUnit,
});
export const MoneyResult = z.strictObject({
  type: z.literal("money"),
  amount: DecimalString,
  currency: CurrencyCode,
  per: UcumUnit.optional(),
});
export const StructuredResult = z.strictObject({
  type: z.literal("structured"),
  schema: z.string().min(1),
  v: z.number().int().positive(),
  value: z.unknown(),
});
/** Known-absent and unknown are always distinct from a value. */
export const UnknownResult = z.strictObject({ type: z.literal("unknown") });
export const NotApplicableResult = z.strictObject({ type: z.literal("not_applicable") });

/** The generic result union; per property the registry narrows it to one declared form. */
export const Result = z.discriminatedUnion("type", [
  QuantityResult,
  CountResult,
  BooleanResult,
  CategoryResult,
  TextResult,
  VectorResult,
  MoneyResult,
  StructuredResult,
  UnknownResult,
  NotApplicableResult,
]);

export type Result = z.infer<typeof Result>;
