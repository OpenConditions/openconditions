import type { Schedule } from "@openconditions/core";
import { normalizeDtToken } from "./digitraffic.js";
import {
  intersectRestrictionWindows,
  normalizeRestrictionDimension,
  toRestrictionInstant,
  type RestrictionWindow,
} from "./restrictions.js";
import type {
  RestrictionIssue,
  RestrictionTokens,
  RoadRestrictionDetailsV1,
  RoadRestrictionFact,
} from "./restriction-types.js";
import { buildLocalSchedule, isoDayToICal, withTimezone } from "./schedule.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Normalizes Fintraffic's phase-scoped vehicle restrictions into the shared
 * contract. Only the five demonstrated structured mappings are normalized;
 * everything else is either known non-vehicle context or an explicit issue.
 * There is deliberately no interpretation of Finnish free text: a restriction
 * this module does not recognize becomes partial evidence, never a guess.
 */

const HELSINKI_TZ = "Europe/Helsinki";

/** The verified source restriction types, with their dimension and scope. */
const DIMENSION_TYPES = {
  VEHICLE_HEIGHT_LIMIT: ["height", "roadwork_phase"],
  VEHICLE_WIDTH_LIMIT: ["width", "roadwork_phase"],
  VEHICLE_LENGTH_LIMIT: ["length", "roadwork_phase"],
  VEHICLE_GROSS_WEIGHT_LIMIT: ["gross_weight", "roadwork_phase"],
  DETOUR_GROSS_WEIGHT_LIMIT: ["gross_weight", "detour"],
} as const;

/**
 * Restriction types that are real source context but say nothing about which
 * vehicles may pass: speeds, signalling, lane and detour state, and work
 * presence. Listing them explicitly keeps them out of the "unknown vehicle
 * restriction" bucket without inferring anything from their names.
 */
const KNOWN_NON_VEHICLE = new Set([
  "SPEED_LIMIT",
  "SPEED_LIMIT_LENGTH",
  "TRAFFIC_LIGHTS",
  "SINGLE_LANE_CLOSED",
  "MULTIPLE_LANES_CLOSED",
  "NARROW_LANES",
  "SINGLE_ALTERNATE_LINE_TRAFFIC",
  "SINGLE_CARRIAGEWAY_CLOSED",
  "ROAD_CLOSED",
  "INTERMITTENT_SHORT_TERM_CLOSURE",
  "INTERMITTENT_SHORT_TERM_STOPS",
  "SLOW_MOVING_MAINTENANCE_VEHICLE",
  "DETOUR",
  "DETOUR_LENGTH",
  "DETOUR_CURVES_STEEP",
  "DETOUR_SURFACE_GRAVEL",
  "DETOUR_SURFACE_PAVED",
  "ROAD_SURFACE_PAVED",
  "ROAD_SURFACE_GRAVEL",
  "ROAD_SURFACE_MILLED",
  "CONTRAFLOW",
  "OPEN_FOR_LOCAL_TRAFFIC",
  "REDUCED_TRAFFIC_CAPACITY",
]);

/**
 * Does an unrecognized enum token claim something about vehicles or physical
 * dimensions? Matched on the documented English enum vocabulary, not on source
 * prose, so an unsupported *vehicle* predicate is reported while unrelated
 * context is not.
 */
function looksVehicleScoped(token: string, hasQuantity: boolean): boolean {
  if (/(?:^|_)VEHICLE(?:_|$)/.test(token)) return true;
  if (/(?:HEIGHT|WIDTH|LENGTH|WEIGHT|MASS|AXLE|TONNE)/.test(token)) return true;
  return hasQuantity && token.endsWith("_LIMIT");
}

const WEEKDAY: Record<string, number> = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function windowOf(value: unknown): RestrictionWindow {
  const span = obj(value);
  return {
    validFrom: span === null ? null : str(span["startTime"]),
    validTo: span === null ? null : str(span["endTime"]),
  };
}

/** Was a supplied window malformed rather than absent? */
function windowMalformed(value: unknown): boolean {
  const span = obj(value);
  if (span === null) return false;
  for (const key of ["startTime", "endTime"]) {
    const raw = span[key];
    if (raw === undefined || raw === null) continue;
    if (toRestrictionInstant(raw) === null) return true;
  }
  return false;
}

interface RoadAddressLocation {
  direction?: unknown;
  directionDescription?: unknown;
  primaryPoint?: unknown;
  secondaryPoint?: unknown;
}

function roadAddressLocation(container: unknown): RoadAddressLocation | null {
  const details = obj(obj(container)?.["locationDetails"]);
  return obj(details?.["roadAddressLocation"]) as RoadAddressLocation | null;
}

const DIRECTION_VALUES: Record<string, "positive" | "negative" | "both"> = {
  POS: "positive",
  POSITIVE: "positive",
  NEG: "negative",
  NEGATIVE: "negative",
  BOTH: "both",
};

/**
 * The source's own carriageway direction. `pos`/`neg` are reference-system
 * orientations, never mapped to an OSM `f`/`b` direction here — that mapping
 * needs the reference system, which this feed does not supply.
 */
function directionOf(
  phase: unknown,
  announcement: unknown
): {
  basis: RoadRestrictionFact["direction"]["basis"];
  value: RoadRestrictionFact["direction"]["value"];
  description: string | null;
  token: string | null;
  conflict: boolean;
} {
  const read = (container: unknown) => {
    const ral = roadAddressLocation(container);
    const token = ral === null ? null : str(ral.direction);
    return {
      token,
      value: token === null ? null : (DIRECTION_VALUES[normalizeDtToken(token)] ?? "unknown"),
      description: ral === null ? null : str(ral.directionDescription),
    };
  };
  const fromPhase = read(phase);
  const fromEvent = read(announcement);
  const chosen = fromPhase.token !== null ? fromPhase : fromEvent;
  const conflict =
    fromPhase.value !== null && fromEvent.value !== null && fromPhase.value !== fromEvent.value;
  if (chosen.token === null) {
    return { basis: "unknown", value: "unknown", description: null, token: null, conflict };
  }
  return {
    basis: "road_reference",
    value: chosen.value ?? "unknown",
    description: chosen.description,
    token: chosen.token,
    conflict,
  };
}

/** The source location identifiers for a scope, without any graph reference. */
function sourceLocationRefs(phase: unknown, announcement: unknown): RestrictionTokens {
  const ral = roadAddressLocation(phase) ?? roadAddressLocation(announcement);
  const primary = obj(obj(ral)?.["primaryPoint"]);
  const secondary = obj(obj(ral)?.["secondaryPoint"]);
  const address = obj(primary?.["roadAddress"]);
  const secondaryAddress = obj(secondary?.["roadAddress"]);
  const refs: RestrictionTokens = { scheme: "digitraffic_road_address" };
  if (typeof address?.["road"] === "number") refs["road"] = address["road"];
  if (typeof address?.["roadSection"] === "number") refs["roadSection"] = address["roadSection"];
  if (typeof address?.["distance"] === "number") refs["primaryDistance"] = address["distance"];
  if (typeof secondaryAddress?.["distance"] === "number") {
    refs["secondaryDistance"] = secondaryAddress["distance"];
  }
  const openlr = str(obj(obj(phase)?.["locationOpenLr"])?.["binary"]);
  if (openlr !== null) refs["openlr"] = openlr;
  return refs;
}

/** Local date in Helsinki for an ISO instant, used to bound working hours. */
function helsinkiDate(instant: string | null): string | undefined {
  if (instant === null) return undefined;
  const epoch = Date.parse(instant);
  if (!Number.isFinite(epoch)) return undefined;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: HELSINKI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epoch));
}

/**
 * Source working hours as display-only local schedules, grouped by time of day
 * and bounded by the phase window. They are context: a weight limit does not
 * stop applying when the crew goes home, so these never reach a fact's
 * `schedule`.
 */
function workingHoursOf(phase: unknown, phaseWindow: RestrictionWindow): Schedule[] | undefined {
  const byTime = new Map<string, { startTime?: string; endTime?: string; byDay: string[] }>();
  for (const entry of arr(obj(phase)?.["workingHours"])) {
    const hour = obj(entry);
    if (hour === null) continue;
    const weekday = str(hour["weekday"]);
    const startTime = str(hour["startTime"]) ?? undefined;
    const endTime = str(hour["endTime"]) ?? undefined;
    const isoDay = weekday === null ? undefined : WEEKDAY[normalizeDtToken(weekday)];
    const iCal = isoDay === undefined ? undefined : isoDayToICal(isoDay);
    if (iCal === undefined && startTime === undefined && endTime === undefined) continue;
    const key = `${startTime ?? ""}-${endTime ?? ""}`;
    const group = byTime.get(key) ?? { startTime, endTime, byDay: [] };
    if (iCal !== undefined && !group.byDay.includes(iCal)) group.byDay.push(iCal);
    byTime.set(key, group);
  }
  if (byTime.size === 0) return undefined;
  const order = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const startDate = helsinkiDate(phaseWindow.validFrom);
  const endDate = helsinkiDate(phaseWindow.validTo);
  const schedules = [...byTime.values()].map((group) =>
    buildLocalSchedule({
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      ...(group.startTime !== undefined ? { startTime: group.startTime } : {}),
      ...(group.endTime !== undefined ? { endTime: group.endTime } : {}),
      ...(group.byDay.length > 0
        ? { byDay: [...group.byDay].sort((a, b) => order.indexOf(a) - order.indexOf(b)) }
        : {}),
    })
  );
  return withTimezone(schedules, HELSINKI_TZ);
}

function commentsOf(phase: unknown, announcement: unknown, language: string | null) {
  const texts: Array<{ text: string; language: string | null }> = [];
  const seen = new Set<string>();
  for (const candidate of [obj(announcement)?.["comment"], obj(phase)?.["comment"]]) {
    const text = str(candidate);
    if (text !== null && !seen.has(text)) {
      seen.add(text);
      texts.push({ text, language });
    }
  }
  return texts.length > 0 ? texts : undefined;
}

/**
 * Extract the record's normalized restriction facts, or `undefined` when the
 * record makes no claim at all about vehicle applicability. `undefined` is not
 * the same as an empty envelope: an empty envelope is a *partial* claim and
 * still blocks shared routing.
 */
export function digitrafficRestrictionDetails(
  props: Record<string, unknown>,
  src: SourceDescriptor
): RoadRestrictionDetailsV1 | undefined {
  const recordId = str(props["situationId"]);
  // Rights travel with every published fact, so a source with no licence URL
  // cannot publish rights-bearing restriction facts at all.
  if (recordId === null || src.licenseUrl === undefined || str(src.licenseUrl) === null) {
    return undefined;
  }
  const announcements = arr(props["announcements"]);
  const announcement = obj(announcements[0]);
  if (announcement === null) return undefined;

  const language = str(announcement["language"]);
  const eventWindow = windowOf(announcement["timeAndDuration"]);
  const eventWindowMalformed = windowMalformed(announcement["timeAndDuration"]);
  const facts: RoadRestrictionFact[] = [];
  const issues: RestrictionIssue[] = [];

  const phases = arr(announcement["roadWorkPhases"]);
  phases.forEach((rawPhase, phaseIndex) => {
    const phase = obj(rawPhase);
    if (phase === null) return;
    const phaseId = str(phase["id"]);
    const phaseWindow = windowOf(phase["timeAndDuration"]);
    const phaseWindowMalformed = windowMalformed(phase["timeAndDuration"]);
    const liftable =
      typeof phase["restrictionsLiftable"] === "boolean"
        ? (phase["restrictionsLiftable"] as boolean)
        : null;
    const direction = directionOf(phase, announcement);
    const refs = sourceLocationRefs(phase, announcement);
    const workingHours = workingHoursOf(phase, phaseWindow);
    const comments = commentsOf(phase, announcement, language);
    const locationDescription =
      str(obj(phase["location"])?.["description"]) ??
      str(obj(announcement["location"])?.["description"]);

    arr(phase["restrictions"]).forEach((rawRestriction, restrictionIndex) => {
      const entry = obj(rawRestriction);
      if (entry === null) return;
      const sourcePath = `announcements[0].roadWorkPhases[${phaseIndex}].restrictions[${restrictionIndex}]`;
      const rawType = str(entry["type"]);
      if (rawType === null) return;
      const token = normalizeDtToken(rawType);
      const detail = obj(entry["restriction"]);
      const quantity = detail?.["quantity"];
      const unit = str(detail?.["unit"]);
      const hasQuantity = typeof quantity === "number";

      const mapping = DIMENSION_TYPES[token as keyof typeof DIMENSION_TYPES];
      if (mapping === undefined) {
        if (!KNOWN_NON_VEHICLE.has(token) && looksVehicleScoped(token, hasQuantity)) {
          issues.push({
            code: "unsupported_type",
            factId: null,
            sourcePath,
            sourceText: rawType,
            sourceTokens: {
              type: rawType,
              ...(str(detail?.["name"]) !== null ? { name: str(detail?.["name"])! } : {}),
              ...(hasQuantity ? { quantity: quantity as number } : {}),
              ...(unit !== null ? { unit } : {}),
            },
          });
        }
        return;
      }

      const [dimension, scopeKind] = mapping;
      const factId = `${recordId}:${phaseId ?? "event"}:${scopeKind}:${sourcePath}`;
      const normalized = normalizeRestrictionDimension({ dimension, value: quantity, unit });
      if (normalized === null) {
        issues.push({
          code: hasQuantity ? "unsupported_unit" : "invalid_value",
          factId,
          sourcePath,
          sourceTokens: {
            type: rawType,
            ...(hasQuantity ? { quantity: quantity as number } : {}),
            ...(unit !== null ? { unit } : {}),
          },
        });
        return;
      }

      const ownWindow = windowOf(detail?.["timeAndDuration"]);
      const ownWindowMalformed = windowMalformed(detail?.["timeAndDuration"]);
      const intersection = intersectRestrictionWindows([eventWindow, phaseWindow, ownWindow]);
      const windowBroken =
        eventWindowMalformed ||
        phaseWindowMalformed ||
        ownWindowMalformed ||
        intersection.issue !== undefined;
      if (windowBroken) {
        issues.push({
          code: "invalid_window",
          factId,
          sourcePath,
          sourceTokens: {
            eventWindow: { ...eventWindow },
            phaseWindow: { ...phaseWindow },
            ...(ownWindow.validFrom !== null || ownWindow.validTo !== null
              ? { restrictionWindow: { ...ownWindow } }
              : {}),
          },
        });
      }
      if (direction.conflict) {
        issues.push({
          code: "conflicting_direction",
          factId,
          sourcePath,
          sourceTokens: { direction: direction.token ?? null },
        });
      }

      facts.push({
        id: factId,
        kind: "dimension",
        dimension,
        meaning: "maximum_permitted",
        value: normalized.value,
        unit: normalized.unit,
        operator: "lte",
        scope: {
          kind: scopeKind,
          phaseId,
          locationDescription,
          // A detour limit keeps its containing phase id but is explicitly not
          // a statement about the affected road itself.
          sourceLocationRefs: refs,
          restrictionBinding: "not_established",
        },
        direction: {
          basis: direction.basis,
          value: direction.value,
          description: direction.description,
        },
        validFrom: windowBroken ? null : intersection.window.validFrom,
        validTo: windowBroken ? null : intersection.window.validTo,
        sourceTokens: {
          sourcePath,
          type: rawType,
          ...(str(detail?.["name"]) !== null ? { name: str(detail?.["name"])! } : {}),
          quantity: quantity as number,
          ...(unit !== null ? { unit } : {}),
          phaseId,
          ...(direction.token !== null ? { direction: direction.token } : {}),
          eventWindow: { ...eventWindow },
          phaseWindow: { ...phaseWindow },
          ...(ownWindow.validFrom !== null || ownWindow.validTo !== null
            ? { restrictionWindow: { ...ownWindow } }
            : {}),
        },
        context: {
          ...(workingHours !== undefined ? { workingHours } : {}),
          restrictionsLiftable: liftable,
          compliance: "unknown",
          operatorActionStatus: null,
          validityStatus: null,
          ...(comments !== undefined ? { comments } : {}),
        },
      });
    });
  });

  if (facts.length === 0 && issues.length === 0) return undefined;

  return {
    schemaVersion: 1,
    vehicleScope: facts.length > 0 ? "specific" : "unknown",
    completeness: issues.length === 0 ? "complete" : "partial",
    facts,
    issues,
    source: {
      sourceId: src.id,
      recordId,
      recordVersion: typeof props["version"] === "number" ? String(props["version"]) : null,
      sourceUpdatedAt:
        toRestrictionInstant(props["versionTime"]) ??
        toRestrictionInstant(props["dataUpdatedTime"]) ??
        toRestrictionInstant(props["releaseTime"]),
      // The trusted feed descriptor supplies the canonical endpoint list at
      // publication time; a parser cannot know which partition served a record.
      feedUrls: [],
      publisher: src.attribution,
      license: src.license,
      licenseUrl: src.licenseUrl,
      attribution: src.attribution,
      modificationNotice:
        "Normalized by OpenConditions; source units and structure may be transformed.",
    },
  };
}
