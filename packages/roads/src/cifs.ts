import { haversineMeters, scheduleTimezoneForGeometry, toIsoTimestamp } from "@openconditions/core";
import { getXmlAttribute, isXmlObject, parseXmlDocument, xmlText } from "@openconditions/datex2";
import { recordSkipped } from "@openconditions/ingest-framework";
import {
  type DirectionRef,
  type InformationSource,
  Iso8601,
  type Issue,
  localDateInZone,
  localTimeInZone,
  type Schedule,
  zonedWallClockToInstant,
} from "@openconditions/model";
import {
  CIFS_LANE_STATUSES,
  CIFS_ROADSIDES,
  cifsClassification,
  isCifsType,
  isValidCifsPair,
} from "@openconditions/model-roads";
import type { LaneStatus, RoadEvent } from "./model.js";
import { buildLocalSchedule, type LocalSchedule, withTimezone } from "./schedule.js";
import { coarseOf } from "./situation/classes.js";
import { text, usableGeometry } from "./situation/location.js";
import {
  canonicalSnapshotValue,
  type RoadSnapshotReport,
  reconcileRoadSnapshots,
} from "./snapshot.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Parser for Waze / Google CIFS (Closure and Incident Feed Specification v2)
 * feeds in both XML (`<incidents>`) and JSON (`{ "incidents": [...] }`) wire
 * formats.
 *
 * Every input record is accounted for through {@link parseCifsSnapshot}:
 * structural, identity, envelope, type/subtype-pair, coordinate, malformed-
 * field, and flat-vs-legacy location conflicts fail closed in `report.errors`
 * so a partial or corrupted poll can never be mistaken for an empty feed.
 * `CHIT_CHAT` records are non-road-condition chatter and are accounted as
 * `terminal`.
 */

const SCHEDULE_DAYS = [
  ["monday", "MO"],
  ["tuesday", "TU"],
  ["wednesday", "WE"],
  ["thursday", "TH"],
  ["friday", "FR"],
  ["saturday", "SA"],
  ["sunday", "SU"],
] as const;

const ALL_ICAL_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const ICAL_BY_UTC_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const KNOWN_SCHEDULE_KEYS = new Set<string>(["everyday", ...SCHEDULE_DAYS.map(([name]) => name)]);

const OPEN_LANE_STATUSES = new Set<string>(["OPEN_LANE", "OPEN", "OPENED"]);
const CLOSED_LANE_STATUSES = new Set<string>(["CLOSED_LANE", "CLOSE", "CLOSED"]);
const KNOWN_LANE_STATUSES = new Set<string>(CIFS_LANE_STATUSES);
const KNOWN_ROADSIDES = new Set<string>(CIFS_ROADSIDES);

/** Maximum road closure polyline length Waze accepts (20 km). */
const MAX_CLOSURE_METERS = 20_000;
const DAY_MS = 86_400_000;

const XML_ARRAY_TAGS = new Set<string>([
  "incident",
  "lane",
  "everyday",
  ...SCHEDULE_DAYS.map(([name]) => name),
]);

type PlainObject = Record<string, unknown>;

type FieldRead =
  | { state: "absent" }
  | { state: "ok"; value: string }
  | { state: "malformed"; raw: unknown };

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Strictly distinguishes absent, valid scalar text, and malformed fields
 * (explicit JSON `null`, arrays such as duplicate XML tags, numbers, booleans,
 * or nested objects).
 */
function readScalarField(node: PlainObject, key: string, format: "xml" | "json"): FieldRead {
  if (!Object.hasOwn(node, key)) return { state: "absent" };
  const raw = node[key];
  if (raw === undefined) return { state: "absent" };
  if (raw === null) return { state: "malformed", raw: null };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? { state: "ok", value: trimmed } : { state: "absent" };
  }
  if (format === "xml" && isXmlObject(raw)) {
    const childKeys = Object.keys(raw).filter((k) => !k.startsWith("@_") && k !== "#text");
    if (childKeys.length > 0) return { state: "malformed", raw };
    const t = raw["#text"];
    if (t === undefined || t === null) return { state: "absent" };
    if (typeof t === "string") {
      const trimmed = t.trim();
      return trimmed.length > 0 ? { state: "ok", value: trimmed } : { state: "absent" };
    }
    return { state: "malformed", raw };
  }
  return { state: "malformed", raw };
}

function normalizeSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseStrictNumber(token: string): number | undefined {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) return undefined;
  const n = Number(token);
  return Number.isFinite(n) ? n : undefined;
}

function parseIntInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
  }
  return undefined;
}

type TimestampRead =
  | { state: "absent" }
  | { state: "ok"; value: string; raw: string }
  | { state: "invalid"; raw: string };

function parseTimestampField(field: FieldRead, timeZone: string | undefined): TimestampRead {
  if (field.state === "absent") return { state: "absent" };
  if (field.state === "malformed") return { state: "invalid", raw: String(field.raw) };
  const iso = toIsoTimestamp(field.value, timeZone);
  if (iso !== undefined && Iso8601.safeParse(iso).success) {
    return { state: "ok", value: iso, raw: field.value };
  }
  return { state: "invalid", raw: field.value };
}

type PolylineResult =
  | { kind: "empty" }
  | { kind: "invalid" }
  | {
      kind: "ok";
      geometry:
        | { type: "Point"; coordinates: [number, number] }
        | { type: "LineString"; coordinates: [number, number][] };
    };

function parsePolyline(raw: string | undefined): PolylineResult {
  if (raw === undefined) return { kind: "empty" };
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "empty" };
  if (tokens.length < 2 || tokens.length % 2 !== 0) return { kind: "invalid" };

  const coords: [number, number][] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const lat = parseStrictNumber(tokens[i]!);
    const lon = parseStrictNumber(tokens[i + 1]!);
    if (lat === undefined || lon === undefined) return { kind: "invalid" };
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { kind: "invalid" };
    const prev = coords.at(-1);
    if (prev !== undefined && prev[0] === lon && prev[1] === lat) continue;
    coords.push([lon, lat]);
  }
  if (coords.length === 0) return { kind: "invalid" };
  const candidate =
    coords.length === 1
      ? ({ type: "Point", coordinates: coords[0]! } as const)
      : ({ type: "LineString", coordinates: coords } as const);
  const valid = usableGeometry(candidate);
  if (!valid || (valid.type !== "Point" && valid.type !== "LineString")) {
    return { kind: "invalid" };
  }
  return { kind: "ok", geometry: candidate };
}

function addLocalDays(date: string, delta: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

function fmtHhMm(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const DST_TRANSITION_DAYS_CACHE = new Map<string, string[]>();

function localMidnightInstant(tz: string, date: string): number | null {
  return zonedWallClockToInstant(tz, `${date}T00:00:00`)?.getTime() ?? null;
}

function utcOffsetMinutesAt(tz: string, date: string): number | null {
  const t = localMidnightInstant(tz, date);
  if (t === null) return null;
  const naive = Date.parse(`${date}T00:00:00Z`);
  return Math.round((naive - t) / 60_000);
}

/**
 * Local calendar dates in `year` on which `tz` changes UTC offset (DST spring/
 * autumn transitions). Cached per `(tz, year)`.
 */
function dstTransitionDays(tz: string, year: number): string[] {
  const cacheKey = `${tz}|${year}`;
  const cached = DST_TRANSITION_DAYS_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  const days: string[] = [];
  for (let month = 1; month <= 12; month++) {
    const start = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const end = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
    const oStart = utcOffsetMinutesAt(tz, start);
    const oEnd = utcOffsetMinutesAt(tz, end);
    if (oStart === null || oEnd === null || oStart === oEnd) continue;

    // Binary search for the transition day inside [start, end).
    let lo = 0;
    let hi = Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS,
    );
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const oMid = utcOffsetMinutesAt(tz, addLocalDays(start, mid));
      if (oMid === oStart) lo = mid;
      else hi = mid;
    }
    days.push(addLocalDays(start, lo));
  }
  DST_TRANSITION_DAYS_CACHE.set(cacheKey, days);
  return days;
}

function isAmbiguousLocalInstant(tz: string, instantMs: number): boolean {
  const wall = localTimeInZone(new Date(instantMs), tz);
  const date = localDateInZone(new Date(instantMs), tz);
  for (const delta of [-3_600_000, 3_600_000, -1_800_000, 1_800_000]) {
    const probe = new Date(instantMs + delta);
    if (localDateInZone(probe, tz) === date && localTimeInZone(probe, tz) === wall) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a recurring local wall-clock window `[startMins, endMins)` on `days`
 * crosses, starts inside, or ends inside a DST transition in `tz` within
 * `[validStartIso, validEndIso]` (or across a representative year when either
 * bound is absent). Fixed-duration `Schedule` evaluation cannot match wall-
 * clock endpoints across such a transition without drifting by an hour.
 */
export function scheduleWindowCrossesDst(
  tz: string,
  startMins: number,
  endMins: number,
  days: readonly string[],
  validStartIso?: string,
  validEndIso?: string,
): boolean {
  const daySet = new Set(days);
  const startMs = validStartIso !== undefined ? Date.parse(validStartIso) : Number.NaN;
  const endMs = validEndIso !== undefined ? Date.parse(validEndIso) : Number.NaN;
  const hasStart = Number.isFinite(startMs);
  const hasEnd = Number.isFinite(endMs);

  if (hasStart && hasEnd && startMs >= endMs) return false;

  const startDate = hasStart ? localDateInZone(new Date(startMs), tz) : undefined;
  const endDate = hasEnd ? localDateInZone(new Date(endMs), tz) : undefined;

  const overnight = endMins <= startMins;
  const nominalMins = overnight ? 24 * 60 - startMins + endMins : endMins - startMins;
  const startWall = `${fmtHhMm(startMins)}:00`;
  const endWall = endMins < 24 * 60 ? `${fmtHhMm(endMins)}:00` : "00:00:00";

  let baseYear: number;
  let lastYear: number;
  if (startDate !== undefined && endDate !== undefined) {
    baseYear = Number(startDate.slice(0, 4)) - (overnight ? 1 : 0);
    lastYear = Math.min(Number(endDate.slice(0, 4)), baseYear + 7);
  } else if (startDate !== undefined) {
    baseYear = Number(startDate.slice(0, 4)) - (overnight ? 1 : 0);
    lastYear = baseYear + 6;
  } else if (endDate !== undefined) {
    lastYear = Number(endDate.slice(0, 4));
    baseYear = lastYear - 6;
  } else {
    baseYear = 2026;
    lastYear = 2032;
  }

  for (let year = baseYear; year <= lastYear; year++) {
    for (const transDay of dstTransitionDays(tz, year)) {
      const candidates = overnight ? [addLocalDays(transDay, -1), transDay] : [transDay];
      for (const occDay of candidates) {
        const dow = ICAL_BY_UTC_DAY[new Date(`${occDay}T00:00:00Z`).getUTCDay()]!;
        if (!daySet.has(dow)) continue;

        const tStart = zonedWallClockToInstant(tz, `${occDay}T${startWall}`);
        const endOccDay = overnight || endMins === 24 * 60 ? addLocalDays(occDay, 1) : occDay;
        const tEnd = zonedWallClockToInstant(tz, `${endOccDay}T${endWall}`);
        if (tStart === null || tEnd === null) {
          if (startDate !== undefined && endOccDay < startDate) continue;
          if (endDate !== undefined && occDay > endDate) continue;
          return true;
        }

        // Check overlap against actual [startMs, endMs) instants so overnight
        // occurrences starting the evening before validStartIso are included.
        const effEndMs = Math.max(tEnd.getTime(), tStart.getTime() + nominalMins * 60_000);
        if (hasStart && effEndMs <= startMs) continue;
        if (hasEnd && tStart.getTime() >= endMs) continue;

        // Spring-forward gap: wall clock shifted past the non-existent hour.
        if (localTimeInZone(tStart, tz) !== startWall) return true;
        if (localTimeInZone(tEnd, tz) !== endWall) return true;

        // Elapsed duration diverges from nominal wall-clock span across DST.
        if (Math.round((tEnd.getTime() - tStart.getTime()) / 60_000) !== nominalMins) return true;

        // Autumn fold: start or end falls on a repeated local hour.
        if (isAmbiguousLocalInstant(tz, tStart.getTime())) return true;
        if (isAmbiguousLocalInstant(tz, tEnd.getTime())) return true;
      }
    }
  }
  return false;
}

interface ParsedWindow {
  key: string;
  startMins: number;
  endMins: number;
  startTime: string;
  endTime?: string;
  duration: string;
}

function isoDurationMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}`;
}

function parseScheduleWindow(segment: string): ParsedWindow | undefined {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(segment.trim());
  if (!match) return undefined;
  const sh = Number(match[1]);
  const sm = Number(match[2]);
  const eh = Number(match[3]);
  const em = Number(match[4]);
  if (sh < 0 || sh > 23 || sm < 0 || sm > 59) return undefined;
  if (!((eh >= 0 && eh <= 23 && em >= 0 && em <= 59) || (eh === 24 && em === 0))) {
    return undefined;
  }
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  // Equal endpoints (e.g. 09:00-09:00) are ambiguous/malformed rather than 24h.
  if (startMins === endMins) return undefined;
  const span = endMins > startMins ? endMins - startMins : 24 * 60 - startMins + endMins;
  const startTime = `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`;
  const endTime =
    eh === 24 ? undefined : `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
  return {
    key: `${startTime}|${endTime ?? "24:00"}|${span}`,
    startMins,
    endMins,
    startTime,
    ...(endTime !== undefined ? { endTime } : {}),
    duration: isoDurationMinutes(span),
  };
}

function extractScheduleStrings(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const entry of value) {
      const textValue = typeof entry === "string" ? entry : xmlText(entry);
      if (textValue === undefined) return undefined;
      out.push(textValue);
    }
    return out;
  }
  const textValue = xmlText(value);
  return textValue !== undefined ? [textValue] : undefined;
}

function parseSchedule(
  node: PlainObject,
  timeZone: string | null,
  validFrom?: string,
  validTo?: string,
): { present: false } | { present: true; schedules?: Schedule[]; issue?: Issue } {
  if (!Object.hasOwn(node, "schedule") || node["schedule"] === undefined) return { present: false };
  const rawSchedule = node["schedule"];
  if (rawSchedule === null) {
    return {
      present: true,
      issue: {
        code: "unsupported_schedule",
        sourcePath: "schedule",
        sourceText: "null schedule",
      },
    };
  }
  if (rawSchedule === "") {
    return {
      present: true,
      issue: {
        code: "unsupported_schedule",
        sourcePath: "schedule",
        sourceText: "empty schedule element",
      },
    };
  }
  if (!isPlainObject(rawSchedule)) {
    return {
      present: true,
      issue: {
        code: "unsupported_schedule",
        sourcePath: "schedule",
        sourceText: "malformed schedule",
      },
    };
  }

  const keys = Object.keys(rawSchedule).filter((k) => !k.startsWith("@_"));
  if (keys.length === 0) {
    return {
      present: true,
      issue: {
        code: "unsupported_schedule",
        sourcePath: "schedule",
        sourceText: "empty schedule",
      },
    };
  }
  for (const key of keys) {
    if (!KNOWN_SCHEDULE_KEYS.has(key)) {
      return {
        present: true,
        issue: {
          code: "unsupported_schedule",
          sourcePath: `schedule.${key}`,
          sourceText: key,
        },
      };
    }
  }

  const windowsByKey = new Map<string, ParsedWindow>();
  const daysByWindow = new Map<string, Set<string>>();

  const addForDays = (
    rawValue: unknown,
    days: readonly string[],
    sourceKey: string,
  ): Issue | undefined => {
    const strings = extractScheduleStrings(rawValue);
    if (!strings || strings.length === 0) {
      return {
        code: "unsupported_schedule",
        sourcePath: `schedule.${sourceKey}`,
        sourceText: "malformed schedule entry",
      };
    }
    for (const s of strings) {
      const trimmed = s.trim();
      if (!trimmed) {
        return {
          code: "unsupported_schedule",
          sourcePath: `schedule.${sourceKey}`,
          sourceText: "empty schedule window",
        };
      }
      // cifsv2.xsd pattern allows an optional trailing comma after a valid window.
      const normalized = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;
      const parts = normalized.split(",");
      if (parts.length === 0) {
        return {
          code: "unsupported_schedule",
          sourcePath: `schedule.${sourceKey}`,
          sourceText: trimmed,
        };
      }
      for (const part of parts) {
        const parsed = parseScheduleWindow(part);
        if (!parsed) {
          return {
            code: "unsupported_schedule",
            sourcePath: `schedule.${sourceKey}`,
            sourceText: trimmed,
          };
        }
        windowsByKey.set(parsed.key, parsed);
        let set = daysByWindow.get(parsed.key);
        if (!set) {
          set = new Set<string>();
          daysByWindow.set(parsed.key, set);
        }
        for (const day of days) set.add(day);
      }
    }
    return undefined;
  };

  if (Object.hasOwn(rawSchedule, "everyday")) {
    const issue = addForDays(rawSchedule["everyday"], ALL_ICAL_DAYS, "everyday");
    if (issue) return { present: true, issue };
  }
  for (const [dayName, icalDay] of SCHEDULE_DAYS) {
    if (Object.hasOwn(rawSchedule, dayName)) {
      const issue = addForDays(rawSchedule[dayName], [icalDay], dayName);
      if (issue) return { present: true, issue };
    }
  }

  if (windowsByKey.size === 0) {
    return {
      present: true,
      issue: {
        code: "unsupported_schedule",
        sourcePath: "schedule",
        sourceText: "empty schedule",
      },
    };
  }
  if (!timeZone) {
    return {
      present: true,
      issue: {
        code: "unsupported_schedule",
        sourcePath: "schedule",
        sourceText: "unable to resolve schedule timezone",
      },
    };
  }

  const localSchedules: LocalSchedule[] = [];
  for (const [key, win] of windowsByKey) {
    const daySet = daysByWindow.get(key)!;
    const orderedDays = ALL_ICAL_DAYS.filter((d) => daySet.has(d));
    // A wall-clock schedule crossing a DST transition cannot be faithfully
    // evaluated via fixed elapsed duration without drifting by an hour.
    if (
      scheduleWindowCrossesDst(
        timeZone,
        win.startMins,
        win.endMins,
        orderedDays,
        validFrom,
        validTo,
      )
    ) {
      return {
        present: true,
        issue: {
          code: "unsupported_schedule",
          sourcePath: "schedule",
          sourceText: `${win.startTime}-${win.endTime ?? "24:00"} crosses DST transition in ${timeZone}`,
        },
      };
    }
    const allDays = orderedDays.length === ALL_ICAL_DAYS.length;
    const built = buildLocalSchedule({
      startTime: win.startTime,
      ...(win.endTime !== undefined ? { endTime: win.endTime } : {}),
      ...(!allDays ? { byDay: orderedDays } : {}),
    });
    // Keep exact duration (including 24h windows where endTime is omitted).
    built.duration = win.duration;
    localSchedules.push(built);
  }
  const stamped = withTimezone(localSchedules, timeZone);
  if (!stamped) {
    return {
      present: true,
      issue: {
        code: "unsupported_schedule",
        sourcePath: "schedule",
        sourceText: "unable to stamp schedule timezone",
      },
    };
  }
  return { present: true, schedules: stamped };
}

interface NormalizedLane {
  order: number;
  type: string;
  status: "open" | "closed";
}

interface ParsedLaneData {
  lanesAffected?: RoadEvent["lanesAffected"];
  issues: Issue[];
}

function roadsideMatchesLanes(roadside: string, trafficLanes: readonly NormalizedLane[]): boolean {
  const n = trafficLanes.length;
  const closedPos: number[] = [];
  for (let i = 0; i < n; i++) {
    if (trafficLanes[i]!.status === "closed") closedPos.push(i);
  }
  if (closedPos.length === 0) return true;
  const count = closedPos.length;
  if (roadside === "LEFT") {
    return count < n && closedPos.every((pos, idx) => pos === idx);
  }
  if (roadside === "RIGHT") {
    return count < n && closedPos.every((pos, idx) => pos === n - count + idx);
  }
  if (roadside === "MIDDLE") {
    return closedPos[0]! > 0 && closedPos.at(-1)! < n - 1;
  }
  return false;
}

function parseLanesField(
  node: PlainObject,
  incidentType: string,
  isSingleDirectionLine: boolean,
  format: "xml" | "json",
): ParsedLaneData {
  const hasLanes = Object.hasOwn(node, "lanes") && node["lanes"] !== undefined;
  const hasImpact = Object.hasOwn(node, "lane_impact") && node["lane_impact"] !== undefined;
  if (!hasLanes && !hasImpact) return { issues: [] };
  const rawLanes = node["lanes"];
  const rawLaneImpact = node["lane_impact"];

  const issueOf = (sourcePath: string, sourceText: string): ParsedLaneData => ({
    ...(incidentType !== "ROAD_CLOSED" ? { lanesAffected: { vehicleImpact: "unknown" } } : {}),
    issues: [{ code: "invalid_value", sourcePath, sourceText }],
  });

  if (incidentType === "ROAD_CLOSED") {
    return issueOf(
      hasLanes ? "lanes" : "lane_impact",
      "partial lane data is not valid on ROAD_CLOSED",
    );
  }
  if (!isSingleDirectionLine) {
    return issueOf(
      hasLanes ? "lanes" : "lane_impact",
      "partial lane data requires a single-direction line",
    );
  }

  let parsedLanes: NormalizedLane[] | undefined;
  if (hasLanes) {
    let rawItems: unknown[];
    if (format === "xml") {
      if (!isXmlObject(rawLanes)) {
        return issueOf("lanes", "malformed lanes element");
      }
      const extraKeys = Object.keys(rawLanes).filter((k) => !k.startsWith("@_") && k !== "lane");
      if (extraKeys.length > 0) {
        return issueOf(`lanes.${extraKeys[0]}`, "unexpected child element in lanes");
      }
      const laneProp = rawLanes["lane"];
      // Keep every raw <lane> entry (including empty <lane/>) so malformed items are never dropped.
      rawItems = laneProp === undefined ? [] : Array.isArray(laneProp) ? laneProp : [laneProp];
    } else if (Array.isArray(rawLanes)) {
      rawItems = rawLanes;
    } else if (isPlainObject(rawLanes) && Array.isArray(rawLanes["lane"])) {
      rawItems = rawLanes["lane"];
    } else {
      return issueOf("lanes", "malformed lanes field");
    }
    if (rawItems.length === 0) return issueOf("lanes", "empty lanes list");

    const seenOrders = new Set<number>();
    const items: NormalizedLane[] = [];
    for (const [i, entry] of rawItems.entries()) {
      if (!isPlainObject(entry)) {
        return issueOf(`lanes[${i}]`, "malformed lane entry");
      }
      const orderField =
        format === "xml"
          ? readScalarField(entry, "order", format)
          : entry["order"] === undefined || entry["order"] === null
            ? { state: "absent" as const }
            : typeof entry["order"] === "number" || typeof entry["order"] === "string"
              ? { state: "ok" as const, value: entry["order"] }
              : { state: "malformed" as const, raw: entry["order"] };
      const typeField = readScalarField(entry, "type", format);
      const statusField = readScalarField(entry, "status", format);

      const order =
        orderField.state === "ok" ? parseIntInRange(orderField.value, 0, 99) : undefined;
      if (order === undefined) return issueOf(`lanes[${i}].order`, String(entry["order"] ?? ""));
      if (seenOrders.has(order)) {
        return issueOf(`lanes[${i}].order`, `duplicate lane order ${order}`);
      }
      seenOrders.add(order);
      if (typeField.state !== "ok")
        return issueOf(`lanes[${i}].type`, "invalid or missing lane type");
      if (statusField.state !== "ok" || !KNOWN_LANE_STATUSES.has(statusField.value)) {
        return issueOf(
          `lanes[${i}].status`,
          statusField.state === "ok" ? statusField.value : "invalid or missing lane status",
        );
      }
      const status: "open" | "closed" = CLOSED_LANE_STATUSES.has(statusField.value)
        ? "closed"
        : OPEN_LANE_STATUSES.has(statusField.value)
          ? "open"
          : "closed";
      items.push({ order, type: typeField.value, status });
    }
    items.sort((a, b) => a.order - b.order);
    parsedLanes = items;
  }

  let parsedImpact: { totalClosedLanes: number; roadside: string } | undefined;
  if (hasImpact) {
    if (!isPlainObject(rawLaneImpact)) {
      return issueOf("lane_impact", "malformed lane_impact");
    }
    const closedField =
      format === "xml"
        ? readScalarField(rawLaneImpact, "total_closed_lanes", format)
        : rawLaneImpact["total_closed_lanes"] === undefined ||
            rawLaneImpact["total_closed_lanes"] === null
          ? { state: "absent" as const }
          : typeof rawLaneImpact["total_closed_lanes"] === "number" ||
              typeof rawLaneImpact["total_closed_lanes"] === "string"
            ? { state: "ok" as const, value: rawLaneImpact["total_closed_lanes"] }
            : { state: "malformed" as const, raw: rawLaneImpact["total_closed_lanes"] };
    const roadsideField = readScalarField(rawLaneImpact, "roadside", format);
    const totalClosedLanes =
      closedField.state === "ok" ? parseIntInRange(closedField.value, 0, 99) : undefined;
    if (totalClosedLanes === undefined) {
      return issueOf(
        "lane_impact.total_closed_lanes",
        String(rawLaneImpact["total_closed_lanes"] ?? ""),
      );
    }
    if (roadsideField.state !== "ok" || !KNOWN_ROADSIDES.has(roadsideField.value)) {
      return issueOf(
        "lane_impact.roadside",
        roadsideField.state === "ok" ? roadsideField.value : "invalid or missing roadside",
      );
    }
    parsedImpact = { totalClosedLanes, roadside: roadsideField.value };
  }

  if (parsedLanes !== undefined) {
    // Only traffic lanes ("LANE" per cifsv2.xsd) determine traffic lane counts.
    const trafficLanes = parsedLanes.filter((l) => l.type.toUpperCase() === "LANE");
    if (trafficLanes.length === 0) {
      return issueOf("lanes", "no traffic lanes (type=LANE) in lanes list");
    }
    const offset = parsedLanes[0]!.order === 0 ? 1 : 0;
    const closedCount = trafficLanes.filter((l) => l.status === "closed").length;
    if (parsedImpact !== undefined) {
      if (parsedImpact.totalClosedLanes !== closedCount) {
        return issueOf(
          "lane_impact.total_closed_lanes",
          `lane_impact (${parsedImpact.totalClosedLanes}) conflicts with lanes (${closedCount})`,
        );
      }
      if (!roadsideMatchesLanes(parsedImpact.roadside, trafficLanes)) {
        return issueOf(
          "lane_impact.roadside",
          `lane_impact roadside ${parsedImpact.roadside} conflicts with closed lane positions`,
        );
      }
    }
    const lanes: LaneStatus[] = trafficLanes.map((l) => ({
      index: l.order + offset,
      status: l.status,
    }));
    // Never synthesize all_lanes_closed from partial lane data on a non-ROAD_CLOSED incident.
    if (closedCount === trafficLanes.length) {
      return {
        lanesAffected: {
          total: trafficLanes.length,
          closed: closedCount,
          lanes,
          vehicleImpact: "unknown",
        },
        issues: [
          {
            code: "invalid_value",
            sourcePath: "lanes",
            sourceText: "all listed traffic lanes closed on non-ROAD_CLOSED incident",
          },
        ],
      };
    }
    return {
      lanesAffected: {
        total: trafficLanes.length,
        closed: closedCount,
        lanes,
        vehicleImpact: closedCount > 0 ? "some-lanes-closed" : "all-lanes-open",
      },
      issues: [],
    };
  }

  // Only lane_impact present: total lane count is unknown, so never derive all_lanes_closed.
  const closed = parsedImpact!.totalClosedLanes;
  return {
    lanesAffected: {
      closed,
      vehicleImpact: closed > 0 ? "some-lanes-closed" : "all-lanes-open",
    },
    issues: [],
  };
}

function parseInformationSource(
  node: PlainObject,
  format: "xml" | "json",
): { ok: true; value?: InformationSource } | { ok: false } {
  let nestedRef: string | undefined;
  let name: string | undefined;
  if (Object.hasOwn(node, "source") && node["source"] !== undefined) {
    const rawSource = node["source"];
    if (rawSource === null || (format === "json" && rawSource === "")) return { ok: false };
    if (rawSource !== "") {
      // Reject duplicate XML <source> arrays and non-object shapes instead of erasing provenance.
      if (!isPlainObject(rawSource)) return { ok: false };
      const refField = readScalarField(rawSource, "reference", format);
      const nameField = readScalarField(rawSource, "name", format);
      if (refField.state === "malformed" || nameField.state === "malformed") return { ok: false };
      if (refField.state === "ok") nestedRef = refField.value;
      if (nameField.state === "ok") name = nameField.value;
    }
  }

  let topRef: string | undefined;
  if (format === "json") {
    const topRefField = readScalarField(node, "reference", format);
    if (topRefField.state === "malformed") return { ok: false };
    if (topRefField.state === "ok") topRef = topRefField.value;
  }

  if (nestedRef !== undefined && topRef !== undefined && nestedRef !== topRef) {
    return { ok: false };
  }
  const ref = nestedRef ?? topRef;
  const out: InformationSource = {};
  if (ref !== undefined) out.id = ref;
  if (name !== undefined) out.name = [{ lang: "und", text: name }];
  return { ok: true, ...(Object.keys(out).length > 0 ? { value: out } : {}) };
}

function parseParentEventId(node: PlainObject, format: "xml" | "json"): FieldRead {
  if (!Object.hasOwn(node, "parent_event")) return { state: "absent" };
  const raw = node["parent_event"];
  if (raw === undefined) return { state: "absent" };
  if (raw === null) return { state: "malformed", raw: null };
  if (format === "xml") {
    if (!isXmlObject(raw)) return { state: "malformed", raw };
    const id = str(getXmlAttribute(raw, "id"));
    return id ? { state: "ok", value: id } : { state: "malformed", raw };
  }
  if (typeof raw === "string") {
    const id = str(raw);
    return id ? { state: "ok", value: id } : { state: "absent" };
  }
  if (isPlainObject(raw)) {
    const idField = readScalarField(raw, "id", format);
    return idField.state === "ok" ? idField : { state: "malformed", raw };
  }
  return { state: "malformed", raw };
}

function mergeLocationField(
  flatField: FieldRead,
  nestedField: FieldRead,
  normalize?: (value: string) => string,
): { ok: true; value?: string } | { ok: false; code: "invalid" | "conflict" } {
  if (flatField.state === "malformed" || nestedField.state === "malformed") {
    return { ok: false, code: "invalid" };
  }
  const flatValue = flatField.state === "ok" ? flatField.value : undefined;
  const nestedValue = nestedField.state === "ok" ? nestedField.value : undefined;
  if (flatValue !== undefined && nestedValue !== undefined) {
    const a = normalize ? normalize(flatValue) : flatValue;
    const b = normalize ? normalize(nestedValue) : nestedValue;
    if (a !== b) return { ok: false, code: "conflict" };
    return { ok: true, value: flatValue };
  }
  return { ok: true, value: flatValue ?? nestedValue };
}

function isHttpErrorStatus(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 400;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) >= 400;
    return ["error", "failed", "failure"].includes(trimmed.toLowerCase());
  }
  return false;
}

function isJsonFailureEnvelope(doc: PlainObject): boolean {
  if (Object.hasOwn(doc, "error") && doc["error"] != null) return true;
  if (Object.hasOwn(doc, "errors") && doc["errors"] != null) return true;
  if (doc["success"] === false || doc["ok"] === false) return true;
  if (isHttpErrorStatus(doc["status"]) || isHttpErrorStatus(doc["statusCode"])) return true;
  return false;
}

function extractRawIncidents(input: string | Buffer): {
  format: "xml" | "json";
  incidents: unknown[];
} {
  const raw = (Buffer.isBuffer(input) ? input.toString("utf8") : input)
    .replace(/^\uFEFF/, "")
    .trimStart();

  if (raw.startsWith("{")) {
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch (error) {
      throw new Error(`cifs: invalid JSON document (${(error as Error).message})`);
    }
    if (!isPlainObject(doc)) {
      throw new Error("cifs: expected JSON object root");
    }
    if (isJsonFailureEnvelope(doc)) {
      throw new Error("cifs: JSON error envelope rejected");
    }
    if (!Array.isArray(doc["incidents"])) {
      throw new Error("cifs: expected JSON object with an incidents array");
    }
    return { format: "json", incidents: doc["incidents"] };
  }

  if (raw.startsWith("<")) {
    const doc = parseXmlDocument(raw, {
      ignoreAttributes: false,
      removeNSPrefix: true,
      validate: true,
      isArray: (name) => XML_ARRAY_TAGS.has(name),
    });
    const rootKeys = Object.keys(doc).filter((k) => k !== "?xml");
    if (rootKeys.length !== 1 || rootKeys[0] !== "incidents") {
      throw new Error("cifs: expected XML <incidents> root element");
    }
    const root = doc["incidents"];
    if (root === "" || root === null || root === undefined) {
      return { format: "xml", incidents: [] };
    }
    if (!isXmlObject(root)) {
      throw new Error("cifs: invalid XML <incidents> root element");
    }
    const unexpectedChildren = Object.keys(root).filter(
      (k) => !k.startsWith("@_") && k !== "incident",
    );
    if (unexpectedChildren.length > 0) {
      throw new Error(
        `cifs: unexpected XML child element under <incidents>: ${unexpectedChildren[0]}`,
      );
    }
    const rawList = root["incident"];
    if (rawList === undefined || rawList === null) {
      return { format: "xml", incidents: [] };
    }
    return { format: "xml", incidents: Array.isArray(rawList) ? rawList : [rawList] };
  }

  throw new Error("cifs: unrecognized payload (expected XML <incidents> or JSON object)");
}

function closureLineIssue(coords: readonly [number, number][]): Issue | undefined {
  if (coords.length < 2) {
    return {
      code: "invalid_value",
      sourcePath: "polyline",
      sourceText: "closure polyline has fewer than two vertices",
    };
  }
  const first = coords[0]!;
  const last = coords.at(-1)!;
  if (coords.length >= 3 && first[0] === last[0] && first[1] === last[1]) {
    return {
      code: "invalid_value",
      sourcePath: "polyline",
      sourceText: "circular closure polyline",
    };
  }
  let lengthMeters = 0;
  for (let i = 1; i < coords.length; i++) {
    lengthMeters += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  if (!(lengthMeters > 0) || lengthMeters > MAX_CLOSURE_METERS) {
    return {
      code: "invalid_value",
      sourcePath: "polyline",
      sourceText:
        lengthMeters > MAX_CLOSURE_METERS
          ? "closure polyline exceeds 20 km"
          : "closure polyline has zero length",
    };
  }
  return undefined;
}

/**
 * Pure CIFS v2 snapshot reader supporting both XML and JSON encodings.
 * Accounts for every input incident so callers can reconcile across partitions
 * and reject partial or contradictory snapshots.
 */
export function parseCifsSnapshot(
  input: string | Buffer,
  src: SourceDescriptor,
): RoadSnapshotReport {
  const { format, incidents } = extractRawIncidents(input);
  const report: RoadSnapshotReport = { inputCount: incidents.length, records: [], errors: [] };
  const now = new Date().toISOString();

  for (const [index, rawItem] of incidents.entries()) {
    const sourcePath = `incidents[${index}]`;
    let node: PlainObject;
    if (format === "json") {
      if (!isPlainObject(rawItem)) {
        report.errors.push({ code: "invalid_record", id: null, sourcePath });
        continue;
      }
      if (Object.hasOwn(rawItem, "incident")) {
        if (Object.keys(rawItem).length !== 1 || !isPlainObject(rawItem["incident"])) {
          report.errors.push({ code: "invalid_record", id: null, sourcePath });
          continue;
        }
        node = rawItem["incident"];
      } else {
        node = rawItem;
      }
    } else {
      if (!isXmlObject(rawItem)) {
        report.errors.push({ code: "invalid_record", id: null, sourcePath });
        continue;
      }
      node = rawItem;
    }

    const idField: FieldRead =
      format === "xml"
        ? (() => {
            const rawAttr = node["@_id"];
            if (rawAttr === undefined || rawAttr === null) return { state: "absent" };
            if (typeof rawAttr !== "string") return { state: "malformed", raw: rawAttr };
            const t = rawAttr.trim();
            return t.length > 0 ? { state: "ok", value: t } : { state: "absent" };
          })()
        : readScalarField(node, "id", format);
    if (idField.state !== "ok") {
      report.errors.push({ code: "invalid_identity", id: null, sourcePath });
      continue;
    }
    const localId = idField.value;
    const id = `${src.id}:${localId}`;

    const createdField = readScalarField(node, "creationtime", format);
    const updatedField = readScalarField(node, "updatetime", format);
    if (createdField.state === "malformed" || updatedField.state === "malformed") {
      report.errors.push({
        code: "invalid_timestamp",
        id,
        sourcePath: `${sourcePath}.${updatedField.state === "malformed" ? "updatetime" : "creationtime"}`,
      });
      continue;
    }
    const created = parseTimestampField(createdField, src.timeZone);
    const updated = parseTimestampField(updatedField, src.timeZone);
    const sourceUpdatedAt =
      (updated.state === "ok" ? updated.value : undefined) ??
      (created.state === "ok" ? created.value : undefined);

    const base = {
      id,
      version: null,
      versionTime: sourceUpdatedAt ?? null,
      fingerprint: canonicalSnapshotValue(node),
    };

    const typeField = readScalarField(node, "type", format);
    const subtypeField = readScalarField(node, "subtype", format);
    if (typeField.state !== "ok" || !isCifsType(typeField.value)) {
      report.errors.push({ code: "unknown_type", id, sourcePath: `${sourcePath}.type` });
      continue;
    }
    if (subtypeField.state === "malformed") {
      report.errors.push({
        code: "invalid_subtype_pair",
        id,
        sourcePath: `${sourcePath}.subtype`,
      });
      continue;
    }
    const rawType = typeField.value;
    const rawSubtype = subtypeField.state === "ok" ? subtypeField.value : undefined;
    if (rawSubtype !== undefined && !isValidCifsPair(rawType, rawSubtype)) {
      report.errors.push({
        code: "invalid_subtype_pair",
        id,
        sourcePath: `${sourcePath}.subtype`,
      });
      continue;
    }

    if (rawType === "CHIT_CHAT") {
      report.records.push({ ...base, disposition: "terminal" });
      continue;
    }

    const classification = cifsClassification(rawType, rawSubtype);
    if (!classification) {
      report.errors.push({ code: "unknown_type", id, sourcePath: `${sourcePath}.type` });
      continue;
    }

    const rawLocation = node["location"];
    let legacyLocation: PlainObject | undefined;
    if (Object.hasOwn(node, "location") && rawLocation !== undefined && rawLocation !== "") {
      if (!isPlainObject(rawLocation)) {
        report.errors.push({
          code: "invalid_location",
          id,
          sourcePath: `${sourcePath}.location`,
        });
        continue;
      }
      legacyLocation = rawLocation;
    }

    const streetMerged = mergeLocationField(
      readScalarField(node, "street", format),
      legacyLocation ? readScalarField(legacyLocation, "street", format) : { state: "absent" },
    );
    const polylineMerged = mergeLocationField(
      readScalarField(node, "polyline", format),
      legacyLocation ? readScalarField(legacyLocation, "polyline", format) : { state: "absent" },
      normalizeSpace,
    );
    const directionMerged = mergeLocationField(
      readScalarField(node, "direction", format),
      legacyLocation ? readScalarField(legacyLocation, "direction", format) : { state: "absent" },
    );
    const locDescMerged = mergeLocationField(
      readScalarField(node, "location_description", format),
      legacyLocation
        ? readScalarField(legacyLocation, "location_description", format)
        : { state: "absent" },
    );
    if (!streetMerged.ok) {
      report.errors.push({
        code: streetMerged.code === "conflict" ? "conflicting_location" : "invalid_location",
        id,
        sourcePath: `${sourcePath}.street`,
      });
      continue;
    }
    if (!polylineMerged.ok) {
      report.errors.push({
        code: polylineMerged.code === "conflict" ? "conflicting_location" : "invalid_geometry",
        id,
        sourcePath: `${sourcePath}.polyline`,
      });
      continue;
    }
    if (!directionMerged.ok) {
      report.errors.push({
        code: directionMerged.code === "conflict" ? "conflicting_location" : "invalid_direction",
        id,
        sourcePath: `${sourcePath}.direction`,
      });
      continue;
    }
    if (!locDescMerged.ok) {
      report.errors.push({
        code: locDescMerged.code === "conflict" ? "conflicting_location" : "invalid_location",
        id,
        sourcePath: `${sourcePath}.location_description`,
      });
      continue;
    }

    const rawDirection = directionMerged.value;
    if (
      rawDirection !== undefined &&
      rawDirection !== "ONE_DIRECTION" &&
      rawDirection !== "BOTH_DIRECTIONS"
    ) {
      report.errors.push({
        code: "invalid_direction",
        id,
        sourcePath: `${sourcePath}.direction`,
      });
      continue;
    }

    const descriptionField = readScalarField(node, "description", format);
    if (descriptionField.state === "malformed") {
      report.errors.push({
        code: "invalid_record",
        id,
        sourcePath: `${sourcePath}.description`,
      });
      continue;
    }
    const sourceParsed = parseInformationSource(node, format);
    if (!sourceParsed.ok) {
      report.errors.push({
        code: "invalid_source",
        id,
        sourcePath: `${sourcePath}.source`,
      });
      continue;
    }
    const parentEventField = parseParentEventId(node, format);
    if (parentEventField.state === "malformed") {
      report.errors.push({
        code: "invalid_record",
        id,
        sourcePath: `${sourcePath}.parent_event`,
      });
      continue;
    }

    const poly = parsePolyline(polylineMerged.value);
    if (poly.kind === "empty") {
      recordSkipped(src.id, "no_geometry", 1);
      report.records.push({ ...base, disposition: "unlocatable" });
      continue;
    }
    if (poly.kind === "invalid") {
      report.errors.push({
        code: "invalid_geometry",
        id,
        sourcePath: `${sourcePath}.polyline`,
      });
      continue;
    }
    const geometry = poly.geometry;

    let directionRef: DirectionRef;
    if (rawDirection === "BOTH_DIRECTIONS") {
      directionRef = { value: "both", basis: "text", text: "BOTH_DIRECTIONS" };
    } else if (geometry.type === "LineString") {
      // Per Waze CIFS spec, an ordered polyline with ONE_DIRECTION or omitted
      // direction affects one direction in coordinate order.
      directionRef = { value: "positive", basis: "geometry" };
    } else if (rawDirection === "ONE_DIRECTION") {
      // Preserve single-direction constraint on a point without widening to both ways.
      directionRef = { value: "positive", basis: "unknown", text: "ONE_DIRECTION" };
    } else {
      directionRef = { value: "unknown", basis: "unknown" };
    }

    const startParsed = parseTimestampField(
      readScalarField(node, "starttime", format),
      src.timeZone,
    );
    const endParsed = parseTimestampField(readScalarField(node, "endtime", format), src.timeZone);

    let validityStatus: "unknown" | undefined;
    let statusIssue: Issue | undefined;
    const effectIssues: Issue[] = [];

    const recordTimingIssue = (issue: Issue) => {
      validityStatus = "unknown";
      if (!statusIssue) statusIssue = issue;
      else effectIssues.push(issue);
    };

    if (startParsed.state === "invalid") {
      recordTimingIssue({
        code: "invalid_window",
        sourcePath: "starttime",
        sourceText: startParsed.raw,
      });
    }
    if (endParsed.state === "invalid") {
      recordTimingIssue({
        code: "invalid_window",
        sourcePath: "endtime",
        sourceText: endParsed.raw,
      });
    }
    const validFrom = startParsed.state === "ok" ? startParsed.value : undefined;
    let validTo = endParsed.state === "ok" ? endParsed.value : undefined;
    if (
      validFrom !== undefined &&
      validTo !== undefined &&
      Date.parse(validTo) < Date.parse(validFrom)
    ) {
      recordTimingIssue({
        code: "invalid_window",
        sourcePath: "endtime",
        sourceText: `${validFrom}..${validTo}`,
      });
      validTo = undefined;
    }

    const isClosure = rawType === "ROAD_CLOSED";
    if (isClosure && validFrom === undefined && startParsed.state === "absent") {
      // Waze requires starttime for closures; never route an unbounded closure without one.
      recordTimingIssue({
        code: "invalid_window",
        sourcePath: "starttime",
        sourceText: "missing starttime on ROAD_CLOSED",
      });
    }

    const scheduleTz = src.timeZone ?? scheduleTimezoneForGeometry(geometry);
    const scheduleResult = parseSchedule(node, scheduleTz, validFrom, validTo);
    let schedule: Schedule[] | undefined;
    if (scheduleResult.present) {
      if (scheduleResult.issue) {
        recordTimingIssue(scheduleResult.issue);
      } else {
        schedule = scheduleResult.schedules;
      }
    }

    if (isClosure) {
      if (geometry.type === "Point") {
        // Retain single-point closures as evidence while withholding them from routing.
        effectIssues.push({
          code: "invalid_value",
          sourcePath: "polyline",
          sourceText: "single-point closure",
        });
      } else {
        const lineIssue = closureLineIssue(geometry.coordinates);
        if (lineIssue) effectIssues.push(lineIssue);
      }
    }

    const isSingleDirectionLine =
      geometry.type === "LineString" && rawDirection !== "BOTH_DIRECTIONS";
    const laneData = parseLanesField(node, rawType, isSingleDirectionLine, format);
    effectIssues.push(...laneData.issues);

    const description = descriptionField.state === "ok" ? descriptionField.value : undefined;
    const street = streetMerged.value;
    const locDesc = locDescMerged.value;
    const informationSource = sourceParsed.value;
    const parentEventId = parentEventField.state === "ok" ? parentEventField.value : undefined;

    const severity: RoadEvent["severity"] =
      rawSubtype === "ACCIDENT_MAJOR"
        ? "high"
        : rawSubtype === "ACCIDENT_MINOR"
          ? "low"
          : "unknown";
    const severitySource: RoadEvent["severitySource"] =
      rawSubtype === "ACCIDENT_MAJOR" || rawSubtype === "ACCIDENT_MINOR" ? "assessed" : "derived";

    const comments = locDesc
      ? [{ type: "public" as const, text: [{ lang: "und", text: locDesc }] }]
      : undefined;

    const event: RoadEvent = {
      id,
      source: src.id,
      sourceFormat: "cifs",
      domain: "roads",
      kind: "event",
      ...coarseOf(classification),
      subtype: rawSubtype ?? rawType,
      severity,
      severitySource,
      status: "active",
      geometry,
      directionRef,
      roads: street ? [{ name: street }] : [],
      headline: description ?? street ?? rawSubtype ?? rawType,
      ...(description !== undefined ? { description } : {}),
      ...(validFrom !== undefined ? { validFrom } : {}),
      ...(validTo !== undefined ? { validTo } : {}),
      ...(schedule !== undefined ? { schedule } : {}),
      ...(isClosure ? { roadState: "closed" as const } : {}),
      ...(laneData.lanesAffected !== undefined ? { lanesAffected: laneData.lanesAffected } : {}),
      situation: {
        classification,
        headlineFromSource: false,
        ...(description !== undefined ? { description: text(description) } : {}),
        ...(comments !== undefined ? { comments } : {}),
        ...(sourceUpdatedAt !== undefined ? { sourceUpdatedAt } : {}),
        ...(informationSource !== undefined ? { informationSource } : {}),
        ...(parentEventId !== undefined
          ? { externalIds: [{ scheme: "cifs:parent_event", id: parentEventId }] }
          : {}),
        ...(validityStatus !== undefined ? { validityStatus } : {}),
        ...(statusIssue !== undefined ? { statusIssue } : {}),
        ...(effectIssues.length > 0 ? { effectIssues } : {}),
      },
      sourceRaw: node,
      origin: {
        kind: "feed",
        attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
      },
      dataUpdatedAt: sourceUpdatedAt ?? now,
      fetchedAt: now,
      isStale: false,
    };

    report.records.push({ ...base, disposition: "accepted", event });
  }

  return report;
}

/**
 * Convenience parser returning reconciled CIFS {@link RoadEvent} records.
 * Unknown identities, malformed records, and conflicting duplicates throw.
 */
export function parseCifs(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  return reconcileRoadSnapshots([parseCifsSnapshot(input, src)]).observations as RoadEvent[];
}
