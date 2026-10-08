import { z } from "zod";
import { getPath } from "./row.js";

const compiles = (pattern: string) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

/** A regular expression as a catalogue writes it: one that compiles. */
export const regexSource = z
  .string()
  .min(1)
  .refine(compiles, { message: "not a valid regular expression" });

/**
 * Where a value sits in a layout record: a dotted path, or a path and a
 * regular expression whose first capture group (else the whole match) is the
 * value. The domains' mapping blocks read every value through one.
 */
export const fieldRef = z.union([
  z.string().min(1),
  z.strictObject({ field: z.string().min(1), pattern: regexSource.optional() }),
]);

export type FieldRef = z.infer<typeof fieldRef>;

/** A field whose source values map onto a closed vocabulary. */
export const mapped = <T extends readonly [string, ...string[]]>(values: T) =>
  z.strictObject({ field: fieldRef, map: z.record(z.string(), z.enum(values)) });

const patterns = new Map<string, RegExp>();

/** A catalogue's regular expression, compiled once however many records read it. */
export function cachedRegex(pattern: string): RegExp {
  let re = patterns.get(pattern);
  if (re === undefined) {
    re = new RegExp(pattern);
    patterns.set(pattern, re);
  }
  return re;
}

/** A string, number or boolean as trimmed text; undefined when empty or not a scalar. */
export function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" ? undefined : text;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * A field's value in a record: the raw value at its path, or, with a pattern,
 * the pattern's first capture group (else the whole match) in its text.
 */
export function readField(fields: Record<string, unknown>, ref: FieldRef): unknown {
  if (typeof ref === "string") return getPath(fields, ref);
  const value = getPath(fields, ref.field);
  if (ref.pattern === undefined) return value;
  const text = scalarText(value);
  if (text === undefined) return undefined;
  const m = text.match(cachedRegex(ref.pattern));
  return m === null ? undefined : (m[1] ?? m[0]);
}

/** A field's value as trimmed text; undefined when absent, empty or not a scalar. */
export function fieldText(
  fields: Record<string, unknown>,
  ref: FieldRef | undefined,
): string | undefined {
  return ref === undefined ? undefined : scalarText(readField(fields, ref));
}

/** The vocabulary value a value map gives a field's text; undefined for a value it does not name. */
export function lookupField<T>(
  fields: Record<string, unknown>,
  rule: { field: FieldRef; map: Record<string, T> } | undefined,
): T | undefined {
  if (rule === undefined) return undefined;
  const key = fieldText(fields, rule.field);
  return key !== undefined && Object.hasOwn(rule.map, key) ? rule.map[key] : undefined;
}
