import { z } from "zod";
import type { Kernel } from "../kernel/effect-type.js";
import { jcs, parseRecordId, sha256Hex } from "../kernel/identity.js";
import { checkRecordBase, recordBaseShape, type Stage } from "../kernel/record-base.js";
import {
  BooleanResult,
  CountResult,
  NotApplicableResult,
  TextResult,
  UnknownResult,
} from "../kernel/result.js";
import { CurrencyCode, DecimalString, Iso8601, Quantity } from "../kernel/scalars.js";
import { enumOf } from "../kernel/vocab.js";
import type { PropertyEntry, PropertyResultSpec, ResultSchemaEntry } from "../registry/define.js";
import { majorOf } from "../registry/define.js";

export const AGGREGATIONS = [
  "instantaneous",
  "mean",
  "median",
  "min",
  "max",
  "sum",
  "p85",
  "typical",
] as const;
export const TRENDS = ["rising", "falling", "steady", "filling", "clearing"] as const;
export const BASELINE_SOURCES = ["native", "derived", "osm_maxspeed", "typical_profile"] as const;

const SegmentSpan = z.strictObject({
  segmentId: z.string().min(1),
  wayId: z.number().int(),
  dir: z.enum(["f", "b"]),
  startFraction: z.number().min(0).max(1),
  endFraction: z.number().min(0).max(1),
});

function subjectSchemas(k: Kernel) {
  return {
    feature: z.strictObject({
      kind: z.literal("feature"),
      featureId: z.string().min(1),
      componentKey: z.string().min(1).optional(),
    }),
    segments: z.strictObject({
      kind: z.literal("segments"),
      spans: z.array(SegmentSpan).min(1),
      direction: k.DirectionRef.optional(),
    }),
    location: z.strictObject({ kind: z.literal("location") }),
    situation: z.strictObject({ kind: z.literal("situation"), situationId: z.string().min(1) }),
  };
}

/**
 * The declared result form of a property, plus the always-allowed `unknown`
 * and `not_applicable`: known-absent and unknown stay distinct from a value.
 */
export function resultSchemaFor(
  spec: PropertyResultSpec,
  vocabularyValues: (code: string) => readonly string[],
  resultSchemas: ReadonlyMap<string, { entry: ResultSchemaEntry; value: z.ZodType }>,
) {
  let declared: z.ZodType;
  switch (spec.type) {
    case "quantity":
      declared = z.strictObject({
        type: z.literal("quantity"),
        value: z.number(),
        unit: z.literal(spec.unit),
        accuracy: z.number().nonnegative().optional(),
      });
      break;
    case "count":
      declared = CountResult;
      break;
    case "boolean":
      declared = BooleanResult;
      break;
    case "text":
      declared = TextResult;
      break;
    case "category":
      declared = z.strictObject({
        type: z.literal("category"),
        value: enumOf(vocabularyValues(spec.vocabulary)),
        vocabulary: z.literal(spec.vocabulary),
      });
      break;
    case "vector":
      declared = z.strictObject({
        type: z.literal("vector"),
        values: z.partialRecord(z.enum(spec.keys as [string, ...string[]]), z.number()),
        unit: z.literal(spec.unit),
      });
      break;
    case "money":
      declared = z.strictObject({
        type: z.literal("money"),
        amount: DecimalString,
        currency: CurrencyCode,
        per:
          spec.per === undefined ? z.never().optional() : z.enum(spec.per as [string, ...string[]]),
      });
      break;
    case "structured": {
      const registered = resultSchemas.get(spec.schema);
      if (registered === undefined) throw new Error(`unknown result schema ${spec.schema}`);
      declared = z.strictObject({
        type: z.literal("structured"),
        schema: z.literal(spec.schema),
        v: z.literal(majorOf(registered.entry.version)),
        value: registered.value,
      });
      break;
    }
  }
  return z.union([declared, UnknownResult, NotApplicableResult]);
}

/**
 * Qualifiers are part of the series key (`qualifier_key`), so their shape is
 * exact: absent when the property declares none, required when any declared
 * key is (an index without its scale must not share a series with one that
 * has it), and never an empty object (`{}` would key a different series than
 * absence).
 */
export function qualifierSchema(entry: PropertyEntry, k: Kernel): z.ZodType {
  if (entry.qualifiers === undefined) return z.never().optional();
  const object = z.strictObject(entry.qualifiers(k));
  const required = !object.safeParse({}).success;
  const nonEmpty = object.refine((q) => Object.keys(q).length > 0, {
    message: "omit qualifiers instead of sending {}",
  });
  return required ? nonEmpty : nonEmpty.optional();
}

export function observationSchema(
  k: Kernel,
  entry: PropertyEntry,
  parts: { result: z.ZodType; qualifiers: z.ZodType },
  stage: Stage,
) {
  const subjects = subjectSchemas(k);
  const allowed = [...new Set(entry.subjects.map((s) => s.kind))].map((kind) => subjects[kind]);
  const subject =
    allowed.length === 1
      ? allowed[0]!
      : z.discriminatedUnion("kind", allowed as [(typeof allowed)[0], ...typeof allowed]);
  const { result, qualifiers } = parts;
  return z
    .strictObject({
      ...recordBaseShape(k, stage),
      class: z.literal("observation"),
      kind: z.literal("observation"),
      property: z.literal(entry.code),
      subject,
      qualifiers,
      result,
      phenomenonTime: z.union([
        z.strictObject({ instant: Iso8601 }),
        z.strictObject({ start: Iso8601, end: Iso8601 }),
      ]),
      resultTime: Iso8601.optional(),
      validUntil: Iso8601.optional(),
      aggregation: z.enum(AGGREGATIONS),
      forecast: z
        .strictObject({
          issuedAt: Iso8601,
          leadTime: Quantity,
          model: z.string().min(1).optional(),
          probability: z.number().min(0).max(1).optional(),
        })
        .optional(),
      quality: z
        .strictObject({
          sampleCount: z.number().int().nonnegative().optional(),
          dataError: z.boolean().optional(),
          confidence: z.number().min(0).max(1).optional(),
          supplierCode: z.string().min(1).optional(),
          verified: z.boolean().optional(),
          trend: z.enum(TRENDS).optional(),
        })
        .optional(),
      baseline: z
        .strictObject({
          freeFlow: Quantity.optional(),
          source: z.enum(BASELINE_SOURCES),
          ratio: z.number().nonnegative().optional(),
          los: z
            .enum(["free_flow", "slow", "heavy", "queuing", "stationary", "blocked", "unknown"])
            .optional(),
        })
        .optional(),
      /** Derived on observation_latest: when a categorical result last changed. */
      sinceAt: stage === "stored" ? Iso8601.optional() : z.never().optional(),
    })
    .superRefine((o, ctx) => {
      checkRecordBase(o, "observation", entry.domain, ctx);
      if ((o.forecast !== undefined) !== (o.temporality === "forecast")) {
        ctx.addIssue({
          code: "custom",
          path: ["forecast"],
          message: 'forecast is present exactly when temporality is "forecast"',
        });
      }
      const t = o.phenomenonTime;
      if ("start" in t && Date.parse(t.start) > Date.parse(t.end)) {
        ctx.addIssue({
          code: "custom",
          path: ["phenomenonTime", "end"],
          message: "end precedes start",
        });
      }
      if (o.subject.kind === "location" && locationKeyOf(o.location) === null) {
        ctx.addIssue({
          code: "custom",
          path: ["location"],
          message: "a location subject needs an admin geocode or a geometry",
        });
        return;
      }
      entry.refine?.(o as Record<string, unknown>, ctx);
      const parts = parseRecordId(o.id);
      if (parts !== null && parts.localId !== observationLocalId(o as Keyable)) {
        ctx.addIssue({
          code: "custom",
          path: ["id"],
          message:
            "an observation's local id is observationLocalId(subject, property, qualifiers, phenomenon start, forecast issue)",
        });
      }
    });
}

interface KeyableLocation {
  geometry: unknown;
  admin?: { geocodes?: readonly { scheme: string; code: string }[] };
}

/** `location:<scheme>:<code>` from the first admin geocode, else the geometry hash; null when neither exists. */
function locationKeyOf(location: KeyableLocation): string | null {
  const geocode = location.admin?.geocodes?.[0];
  if (geocode !== undefined) return `location:${geocode.scheme}:${geocode.code}`;
  if (location.geometry !== null && location.geometry !== undefined) {
    return `location:${sha256Hex(jcs(location.geometry))}`;
  }
  return null;
}

/**
 * The storage subject key. Only the identifying part is keyed, never
 * the whole LocationRef: names, fuzziness and geometryOrigin change without
 * the subject changing, and hashing them would break a series in two.
 */
export function subjectKey(o: {
  subject:
    | { kind: "feature"; featureId: string; componentKey?: string }
    | { kind: "segments"; spans: unknown[] }
    | { kind: "location" }
    | { kind: "situation"; situationId: string };
  location: KeyableLocation;
}): string {
  switch (o.subject.kind) {
    case "feature":
      return o.subject.componentKey === undefined
        ? `feature:${o.subject.featureId}`
        : `feature:${o.subject.featureId}#${o.subject.componentKey}`;
    case "segments":
      return `segments:${sha256Hex(jcs(o.subject.spans))}`;
    case "situation":
      return `situation:${o.subject.situationId}`;
    case "location": {
      const key = locationKeyOf(o.location);
      if (key === null)
        throw new TypeError("a location subject needs an admin geocode or a geometry");
      return key;
    }
  }
}

/** RFC 8785 JCS of the qualifiers, "" when absent. */
export function qualifierKey(qualifiers: Record<string, unknown> | undefined): string {
  return qualifiers === undefined ? "" : jcs(qualifiers);
}

type Keyable = Parameters<typeof subjectKey>[0] & {
  property: string;
  qualifiers?: Record<string, unknown>;
  phenomenonTime: { instant: string } | { start: string; end: string };
  forecast?: { issuedAt: string };
};

/**
 * The local id of an observation: one point of one series. The series is
 * (subject key, property, qualifier key); the point is the phenomenon start,
 * normalised to UTC so two spellings of one instant are one point, plus the
 * issue time for a forecast (several forecasts target the same time).
 */
export function observationLocalId(o: Keyable): string {
  const t = o.phenomenonTime;
  const start = new Date("instant" in t ? t.instant : t.start).toISOString();
  return sha256Hex(
    jcs([
      subjectKey(o),
      o.property,
      qualifierKey(o.qualifiers),
      start,
      o.forecast === undefined ? null : new Date(o.forecast.issuedAt).toISOString(),
    ]),
  );
}

/** `oc:observation:<namespace>:<observationLocalId>`. */
export function observationId(namespace: string, o: Keyable): string {
  return `oc:observation:${namespace}:${observationLocalId(o)}`;
}
