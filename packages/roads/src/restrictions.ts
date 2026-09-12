import { z } from "zod";
import { RESTRICTION_TEXT_LIMIT } from "./restriction-types.js";
import type {
  PublishedRoadRestrictionDetailsV1,
  RestrictionCarrier,
  RoadRestrictionDetailsV1,
  RoadRestrictionFact,
} from "./restriction-types.js";

/**
 * Runtime authority for the normalized restriction contract: presence
 * detection and strict envelope validation. Everything here is pure — no
 * clock, no source parsing, and no unit inference beyond the explicitly
 * supported conversions.
 */

/**
 * Does this carrier say anything at all about vehicle applicability?
 *
 * Own-property presence is deliberate. A carrier holding
 * `restrictionDetails: undefined` has *claimed* restriction evidence and must
 * not be read as an unrestricted record; only a carrier with no such property
 * and no unsupported marker counts as absence.
 */
export function hasRestrictionEvidence(value: object): boolean {
  return (
    Object.prototype.hasOwnProperty.call(value, "restrictionDetails") ||
    (value as RestrictionCarrier).restrictionDetailsUnsupported === true
  );
}

const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse an ISO instant that carries an explicit zone, denotes a real calendar
 * date and lands on a finite epoch. `Date.parse` alone accepts overflow days
 * ("2026-02-30") and zone-less local strings, either of which would silently
 * change a restriction's meaning.
 */
export function parseRestrictionInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = INSTANT_PATTERN.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59)) return null;
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch)) return null;
  // Reject an overflow day the zone offset cannot explain (e.g. 2026-02-30):
  // rebuild the same wall clock as UTC and compare its calendar date.
  const asUtc = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}Z`);
  if (!Number.isFinite(asUtc)) return null;
  const local = new Date(asUtc);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() + 1 !== month ||
    local.getUTCDate() !== day
  ) {
    return null;
  }
  return epoch;
}

/** Normalize a validated instant to a canonical ISO-UTC string, else null. */
export function toRestrictionInstant(value: unknown): string | null {
  const epoch = parseRestrictionInstant(value);
  return epoch === null ? null : new Date(epoch).toISOString();
}

const MAX_TOKEN_DEPTH = 8;

/**
 * Is this a finite JSON value safe to persist and publish? Rejects functions,
 * symbols, cycles, nonfinite numbers, class instances and over-long strings, so
 * a token bag can never smuggle a raw record or an unserializable value through.
 */
function isFiniteJsonValue(value: unknown, depth: number): boolean {
  if (depth > MAX_TOKEN_DEPTH) return false;
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "string":
      return [...value].length <= RESTRICTION_TEXT_LIMIT;
    case "object":
      break;
    default:
      return false;
  }
  if (Array.isArray(value)) return value.every((entry) => isFiniteJsonValue(entry, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value as Record<string, unknown>).every((entry) =>
    isFiniteJsonValue(entry, depth + 1)
  );
}

const tokensSchema = z.custom<Record<string, unknown>>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    isFiniteJsonValue(value, 0),
  { message: "expected a bounded finite-JSON token object" }
);

const boundedText = z.string().max(RESTRICTION_TEXT_LIMIT);
const instantSchema = z.string().refine((v) => parseRestrictionInstant(v) !== null, {
  message: "expected an ISO instant with an explicit zone and a real calendar date",
});
const httpUrl = z
  .string()
  .refine((v) => /^https?:\/\/\S+$/i.test(v), { message: "expected an http(s) URL" });

const scheduleSchema = z.object({
  repeatFrequency: z.string().optional(),
  repeatCount: z.number().int().nonnegative().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  duration: z.string().optional(),
  byDay: z.array(z.string()).optional(),
  byMonth: z.array(z.number().int()).optional(),
  byMonthDay: z.array(z.number().int()).optional(),
  exceptDate: z.array(z.string()).optional(),
  scheduleTimezone: z.string().min(1),
});

/** The closed issue-code set of contract version 1. */
export const RESTRICTION_ISSUE_CODES = [
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
] as const;

const issueSchema = z.object({
  code: z.enum(RESTRICTION_ISSUE_CODES),
  factId: z.string().min(1).nullable(),
  sourcePath: z.string(),
  sourceText: boundedText.optional(),
  sourceTokens: tokensSchema.optional(),
  truncated: z.literal(true).optional(),
});

const sourceSchema = z.object({
  sourceId: z.string().min(1),
  recordId: z.string().min(1),
  recordVersion: z.string().min(1).nullable(),
  sourceUpdatedAt: instantSchema.nullable(),
  feedUrls: z.array(httpUrl),
  publisher: z.string().min(1),
  license: z.string().min(1),
  licenseUrl: httpUrl,
  attribution: z.string().min(1),
  modificationNotice: z.string().min(1),
  notices: z.array(boundedText).optional(),
});

const factBaseShape = {
  id: z.string().min(1),
  scope: z.object({
    kind: z.enum(["event_road", "roadwork_phase", "detour"]),
    phaseId: z.string().min(1).nullable(),
    locationDescription: boundedText.nullable(),
    sourceLocationRefs: tokensSchema,
    restrictionBinding: z.literal("not_established"),
  }),
  direction: z.object({
    basis: z.enum(["road_reference", "alert_c", "openlr", "unknown"]),
    value: z.enum(["positive", "negative", "both", "unknown"]),
    description: boundedText.nullable(),
  }),
  validFrom: instantSchema.nullable(),
  validTo: instantSchema.nullable(),
  schedule: z.array(scheduleSchema).optional(),
  sourceTokens: tokensSchema,
  context: z.object({
    workingHours: z.array(scheduleSchema).optional(),
    restrictionsLiftable: z.boolean().nullable(),
    compliance: z.enum(["mandatory", "advisory", "unknown"]),
    operatorActionStatus: z.string().nullable(),
    validityStatus: z.string().nullable(),
    comments: z.array(z.object({ text: boundedText, language: z.string().nullable() })).optional(),
  }),
};

const dimensionShape = {
  ...factBaseShape,
  kind: z.literal("dimension"),
  dimension: z.enum(["height", "width", "length", "gross_weight"]),
  meaning: z.enum(["maximum_permitted", "event_applies_when"]),
  value: z.number(),
  unit: z.enum(["m", "kg"]),
  operator: z.enum(["lt", "lte", "eq", "gte", "gt"]),
};

const vehicleClassShape = {
  ...factBaseShape,
  kind: z.literal("vehicle_class"),
  meaning: z.literal("event_applies_when"),
  value: z.enum(["truck"]),
};

const vehicleUsageShape = {
  ...factBaseShape,
  kind: z.literal("vehicle_usage"),
  meaning: z.literal("event_applies_when"),
  value: z.enum(["emergency_services"]),
};

const stateShape = { state: z.enum(["active", "scheduled", "ended", "unknown"]) };

const factSchema = z.discriminatedUnion("kind", [
  z.object(dimensionShape),
  z.object(vehicleClassShape),
  z.object(vehicleUsageShape),
]);

const publishedFactSchema = z.discriminatedUnion("kind", [
  z.object({ ...dimensionShape, ...stateShape }),
  z.object({ ...vehicleClassShape, ...stateShape }),
  z.object({ ...vehicleUsageShape, ...stateShape }),
]);

/**
 * A dimension fact must be internally consistent: a finite positive quantity,
 * the unit its dimension normalizes to, and `lte` whenever it claims to be a
 * permitted maximum — otherwise a `gt` predicate could be displayed as a limit.
 */
function dimensionConsistent(fact: Extract<RoadRestrictionFact, { kind: "dimension" }>): boolean {
  return (
    Number.isFinite(fact.value) &&
    fact.value > 0 &&
    (fact.dimension === "gross_weight" ? fact.unit === "kg" : fact.unit === "m") &&
    (fact.meaning !== "maximum_permitted" || fact.operator === "lte")
  );
}

type EnvelopeForRefine = {
  facts: RoadRestrictionFact[];
  vehicleScope: string;
  completeness: string;
  issues: unknown[];
};

/**
 * Cross-field envelope rules. An empty `facts` array is only meaningful as
 * declared partial/unknown evidence with at least one issue — never as a
 * complete statement that nothing is restricted.
 */
function refineEnvelope(details: EnvelopeForRefine, ctx: z.RefinementCtx): void {
  if (details.facts.length === 0) {
    if (
      details.vehicleScope !== "unknown" ||
      details.completeness !== "partial" ||
      details.issues.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "an empty fact list requires unknown/partial evidence and at least one issue",
      });
    }
  }
  const ids = new Set<string>();
  for (const fact of details.facts) {
    if (ids.has(fact.id)) {
      ctx.addIssue({ code: "custom", message: `duplicate fact id ${fact.id}` });
    }
    ids.add(fact.id);
    if (fact.kind === "dimension" && !dimensionConsistent(fact)) {
      ctx.addIssue({
        code: "custom",
        message: `fact ${fact.id} has an inconsistent quantity, unit, meaning or comparator`,
      });
    }
    if (fact.validFrom !== null && fact.validTo !== null) {
      const from = parseRestrictionInstant(fact.validFrom);
      const to = parseRestrictionInstant(fact.validTo);
      if (from === null || to === null || from >= to) {
        ctx.addIssue({
          code: "custom",
          message: `fact ${fact.id} has a non-increasing validity window`,
        });
      }
    }
  }
}

const envelopeShape = {
  schemaVersion: z.literal(1),
  vehicleScope: z.enum(["specific", "unknown"]),
  completeness: z.enum(["complete", "partial"]),
  issues: z.array(issueSchema),
  source: sourceSchema,
};

const detailsSchema = z
  .object({ ...envelopeShape, facts: z.array(factSchema) })
  .superRefine((value, ctx) => refineEnvelope(value as EnvelopeForRefine, ctx));

const publishedDetailsSchema = z
  .object({
    ...envelopeShape,
    facts: z.array(publishedFactSchema),
    evaluatedAt: instantSchema,
    sourceCheckedAt: instantSchema.nullable(),
    freshUntil: instantSchema.nullable(),
    nextTransitionAt: instantSchema.nullable(),
    isStale: z.boolean(),
  })
  .superRefine((value, ctx) => refineEnvelope(value as EnvelopeForRefine, ctx));

/** Strict validation of a persisted (unevaluated) restriction envelope. */
export function isRoadRestrictionDetails(value: unknown): value is RoadRestrictionDetailsV1 {
  return detailsSchema.safeParse(value).success;
}

/** Strict validation of a published (evaluated) restriction envelope. */
export function isPublishedRoadRestrictionDetails(
  value: unknown
): value is PublishedRoadRestrictionDetailsV1 {
  return publishedDetailsSchema.safeParse(value).success;
}

/**
 * Validate and return the envelope, or null. Returns the caller's own object so
 * no unknown key is silently stripped into a different-looking value.
 */
export function parseRoadRestrictionDetails(value: unknown): RoadRestrictionDetailsV1 | null {
  return isRoadRestrictionDetails(value) ? value : null;
}
