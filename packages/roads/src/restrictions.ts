import { isInEffectAt, nextScheduleTransition } from "@openconditions/core";
import { z } from "zod";
import { RESTRICTION_TEXT_LIMIT } from "./restriction-types.js";

// Re-exported so a consumer that needs only the contract can import this one
// module without pulling in the feed catalogue through the package barrel.
export * from "./restriction-types.js";

import type {
  PublishedRoadRestrictionDetailsV1,
  RestrictionCarrier,
  RestrictionIssue,
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
    Object.hasOwn(value, "restrictionDetails") ||
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

/** Bound diagnostic evidence without invalidating otherwise usable sibling facts. */
export function boundRestrictionIssue(issue: RestrictionIssue): RestrictionIssue {
  let truncated = issue.truncated === true;
  const clip = (value: unknown, depth = 0): unknown => {
    if (typeof value === "string") {
      if (value.length <= RESTRICTION_TEXT_LIMIT) return value;
      truncated = true;
      return `${value.slice(0, RESTRICTION_TEXT_LIMIT - 1)}…`;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (depth < MAX_TOKEN_DEPTH && typeof value === "object" && value !== null) {
      if (Array.isArray(value)) return value.map((entry) => clip(entry, depth + 1));
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, clip(entry, depth + 1)]),
      );
    }
    truncated = true;
    return null;
  };
  const sourceText =
    issue.sourceText === undefined ? undefined : (clip(issue.sourceText) as string);
  const sourceTokens =
    issue.sourceTokens === undefined
      ? undefined
      : (clip(issue.sourceTokens) as RestrictionIssue["sourceTokens"]);
  return {
    ...issue,
    ...(sourceText === undefined ? {} : { sourceText }),
    ...(sourceTokens === undefined ? {} : { sourceTokens }),
    ...(truncated ? { truncated: true } : {}),
  };
}

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
    isFiniteJsonValue(entry, depth + 1),
  );
}

const tokensSchema = z.custom<Record<string, unknown>>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    isFiniteJsonValue(value, 0),
  { message: "expected a bounded finite-JSON token object" },
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
  value: unknown,
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

/** A source validity window, already normalized to ISO-UTC instants or null. */
export interface RestrictionWindow {
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Intersect event → phase → restriction windows: known starts take the
 * maximum, known ends the minimum. A malformed bound or an empty result is
 * reported as `invalid_window` with null bounds, and the caller MUST retain
 * that issue — null bounds alone would otherwise read as "applies always",
 * i.e. the exact opposite of "we could not understand when this applies".
 */
export function intersectRestrictionWindows(windows: RestrictionWindow[]): {
  window: RestrictionWindow;
  issue?: "invalid_window";
} {
  const invalid = { window: { validFrom: null, validTo: null }, issue: "invalid_window" } as const;
  let from: number | null = null;
  let to: number | null = null;
  for (const candidate of windows) {
    if (candidate.validFrom !== null && candidate.validFrom !== undefined) {
      const parsed = parseRestrictionInstant(candidate.validFrom);
      if (parsed === null) return invalid;
      from = from === null ? parsed : Math.max(from, parsed);
    }
    if (candidate.validTo !== null && candidate.validTo !== undefined) {
      const parsed = parseRestrictionInstant(candidate.validTo);
      if (parsed === null) return invalid;
      to = to === null ? parsed : Math.min(to, parsed);
    }
  }
  if (from !== null && to !== null && from >= to) return invalid;
  return {
    window: {
      validFrom: from === null ? null : new Date(from).toISOString(),
      validTo: to === null ? null : new Date(to).toISOString(),
    },
  };
}

/**
 * Convert a source quantity to the contract's canonical unit. Lengths stay in
 * metres; gross weight becomes kilograms. There is deliberately no numeric-string
 * coercion, no rounding and no default unit: an unrecognized unit returns null so
 * the caller records an issue rather than publishing a number with invented
 * meaning.
 */
export function normalizeRestrictionDimension(input: {
  dimension: "height" | "width" | "length" | "gross_weight";
  value: unknown;
  unit: unknown;
}): { value: number; unit: "m" | "kg" } | null {
  if (typeof input.value !== "number" || !Number.isFinite(input.value) || input.value <= 0) {
    return null;
  }
  if (input.dimension !== "gross_weight") {
    return input.unit === "m" ? { value: input.value, unit: "m" } : null;
  }
  const value = input.unit === "t" ? input.value * 1000 : input.unit === "kg" ? input.value : NaN;
  return Number.isFinite(value) && value > 0 ? { value, unit: "kg" } : null;
}

/** Read metadata needed to evaluate a restriction view deterministically. */
export interface RestrictionEvaluation {
  /** Explicit evaluation instant; injected so tests never depend on wall time. */
  at: Date;
  /** When the source was last successfully checked, from generic source status. */
  sourceCheckedAt: string | null;
  /** The source's configured freshness window, in seconds. */
  freshnessWindowSec: number | null;
}

/** Issue codes that make a fact's temporal interpretation unknown. */
const TEMPORAL_BLOCKING_CODES: ReadonlySet<string> = new Set([
  "invalid_window",
  "unsupported_schedule",
]);

function factIssueCodes(
  details: RoadRestrictionDetailsV1,
  factId: string,
): { temporalUnknown: boolean; statusUnsupported: boolean } {
  let temporalUnknown = false;
  let statusUnsupported = false;
  for (const issue of details.issues) {
    // A null factId is a whole-record issue and therefore applies to every fact.
    if (issue.factId !== null && issue.factId !== factId) continue;
    if (TEMPORAL_BLOCKING_CODES.has(issue.code)) temporalUnknown = true;
    if (issue.code === "unsupported_status") statusUnsupported = true;
  }
  return { temporalUnknown, statusUnsupported };
}

function scheduleState(
  fact: RoadRestrictionFact,
  at: Date,
): "active" | "scheduled" | "ended" | "unknown" {
  const schedules = fact.schedule ?? [];
  if (isInEffectAt({ validFrom: fact.validFrom, validTo: fact.validTo, schedule: schedules }, at)) {
    return "active";
  }
  // Between occurrences: a future transition the existing helper can identify
  // means scheduled; an exhausted recurrence with a passed final end is ended.
  if (nextScheduleTransition(schedules, at) !== null) return "scheduled";
  if (fact.validTo !== null && parseRestrictionInstant(fact.validTo)! <= at.getTime()) {
    return "ended";
  }
  // The helpers could not establish the next state. Never label such a fact
  // continuously active just because no end was found.
  return "unknown";
}

/**
 * The temporal state of one fact at `at`. End bounds are exclusive, so a fact
 * is ended at its own end instant. Working hours are deliberately not consulted:
 * a weight limit does not disappear when nobody is on site.
 */
function evaluateFactState(
  details: RoadRestrictionDetailsV1,
  fact: RoadRestrictionFact,
  at: Date,
): "active" | "scheduled" | "ended" | "unknown" {
  const { temporalUnknown, statusUnsupported } = factIssueCodes(details, fact.id);
  if (temporalUnknown) return "unknown";
  const from = fact.validFrom === null ? null : parseRestrictionInstant(fact.validFrom);
  const to = fact.validTo === null ? null : parseRestrictionInstant(fact.validTo);
  if (from === null && fact.validFrom !== null) return "unknown";
  if (to === null && fact.validTo !== null) return "unknown";
  const now = at.getTime();
  if (!Number.isFinite(now)) return "unknown";
  if (to !== null && now >= to) return "ended";
  if (from !== null && now < from) return "scheduled";
  if (statusUnsupported) return "unknown";
  if (fact.schedule !== undefined && fact.schedule.length > 0) return scheduleState(fact, at);
  // A known start that has passed is a fully understood open or closed interval.
  return from !== null ? "active" : "unknown";
}

/** The earliest future start, end or represented recurrence transition. */
function nextTransition(details: RoadRestrictionDetailsV1, at: Date): string | null {
  const now = at.getTime();
  if (!Number.isFinite(now)) return null;
  const candidates: number[] = [];
  for (const fact of details.facts) {
    const { temporalUnknown } = factIssueCodes(details, fact.id);
    if (temporalUnknown) continue;
    for (const bound of [fact.validFrom, fact.validTo]) {
      const epoch = bound === null ? null : parseRestrictionInstant(bound);
      if (epoch !== null && epoch > now) candidates.push(epoch);
    }
    if (fact.schedule !== undefined && fact.schedule.length > 0) {
      const transition = nextScheduleTransition(fact.schedule, at);
      const epoch = transition === null ? null : parseRestrictionInstant(transition);
      if (epoch !== null && epoch > now) candidates.push(epoch);
    }
  }
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates)).toISOString();
}

/**
 * Project persisted source semantics into the published view. The input is
 * never mutated: evaluated state lives only in the returned object, so it can
 * never reach the content hash or the attributes column.
 *
 * A present-but-invalid envelope becomes `{restrictionDetailsUnsupported:true}`
 * — an uninterpretable restriction claim still blocks shared routing and still
 * shows a generic notice, rather than quietly becoming an absent restriction.
 */
export function projectRoadRestrictionDetails(
  value: unknown,
  options: RestrictionEvaluation,
): {
  restrictionDetails?: PublishedRoadRestrictionDetailsV1;
  restrictionDetailsUnsupported?: true;
} {
  const details = parseRoadRestrictionDetails(value);
  if (details === null) return { restrictionDetailsUnsupported: true };
  const at = options.at;
  // An unusable evaluation instant cannot produce a trustworthy view, and an
  // untrustworthy view must degrade to "unsupported", never to "no restriction".
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    return { restrictionDetailsUnsupported: true };
  }
  const evaluatedAt = at.toISOString();

  const checked =
    options.sourceCheckedAt === null ? null : parseRestrictionInstant(options.sourceCheckedAt);
  const windowSec = options.freshnessWindowSec;
  const freshUntilEpoch =
    checked !== null && typeof windowSec === "number" && Number.isFinite(windowSec) && windowSec > 0
      ? checked + windowSec * 1000
      : null;
  // Missing checked time or freshness window can never imply freshness.
  const isStale = freshUntilEpoch === null || at.getTime() >= freshUntilEpoch;

  return {
    restrictionDetails: {
      ...details,
      facts: details.facts.map((fact) => ({
        ...fact,
        state: evaluateFactState(details, fact, at),
      })),
      evaluatedAt,
      sourceCheckedAt: checked === null ? null : new Date(checked).toISOString(),
      freshUntil: freshUntilEpoch === null ? null : new Date(freshUntilEpoch).toISOString(),
      nextTransitionAt: nextTransition(details, at),
      isStale,
    },
  };
}

/** Maximum lifetime of a restriction view, in milliseconds. */
export const RESTRICTION_VIEW_MAX_AGE_MS = 60_000;

/**
 * When a published restriction view stops being trustworthy: the earliest
 * future freshness or transition deadline, capped at one minute.
 *
 * A stale or freshness-less view returns `at` itself, which callers translate
 * into "do not cache". The cap exists because a long deadline would let a
 * cached response outlive the poll that justified it.
 */
export function restrictionViewDeadline(
  details: readonly PublishedRoadRestrictionDetailsV1[],
  at: Date,
): Date {
  const now = at.getTime();
  if (!Number.isFinite(now)) return at;
  const ceiling = now + RESTRICTION_VIEW_MAX_AGE_MS;
  let earliest = ceiling;
  for (const view of details) {
    // A view that is already stale, or that has no freshness basis at all,
    // must not extend any caller's cache lifetime.
    if (view.isStale || view.freshUntil === null) return at;
    const evaluatedAt = parseRestrictionInstant(view.evaluatedAt);
    if (evaluatedAt === null || evaluatedAt + RESTRICTION_VIEW_MAX_AGE_MS <= now) return at;
    earliest = Math.min(earliest, evaluatedAt + RESTRICTION_VIEW_MAX_AGE_MS);
    for (const deadline of [view.freshUntil, view.nextTransitionAt]) {
      const epoch = deadline === null ? null : parseRestrictionInstant(deadline);
      if (deadline === null) continue;
      if (epoch === null) return at;
      if (epoch <= now) return at;
      if (epoch < earliest) earliest = epoch;
    }
  }
  return new Date(earliest);
}
