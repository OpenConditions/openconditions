import { createHash } from "node:crypto";
import { haversineMeters, scheduleTimezoneForGeometry } from "@openconditions/core";
import {
  type DirectionRef,
  type Effect,
  effectValidity,
  type Geometry,
  localDateInZone,
  type Schedule,
  type Validity,
  zonedWallClockToInstant,
} from "@openconditions/model";
import {
  type CifsIncidentCode,
  type CifsType,
  type CifsXsdSubtype,
  cifsIncidentCodeOf,
} from "@openconditions/model-roads";
import { scheduleWindowCrossesDst } from "@openconditions/roads";
import { type ExportDiagnosticSink, ProjectionDiagnostics } from "./export-diagnostics.js";
import {
  definesManagementNature,
  omittedPath,
  type ProjectionEffect,
  projectionEffects,
  projectionStateAt,
} from "./export-validity.js";
import { buildXmlDocument, xmlChars } from "./xml.js";

type Rec = Record<string, unknown>;

/**
 * CIFS (Closure and Incident Feed Specification v2) outbound emitter for both
 * XML (`<incidents>`) and JSON (`{ timestamp, incidents }`).
 *
 * Emits only XSD-valid `cifsv2.xsd` values: never writes deprecated
 * `CONSTRUCTION`, `CHIT_CHAT`, or doc-only subtypes. Full `ROAD_CLOSED`
 * incidents require a complete, active or confirmed-scheduled, mandatory,
 * road-wide (non-lane-scoped) `closure` effect, an explicit `validity.start`
 * timestamp, and a non-circular `LineString` of length > 0 m and ≤ 20,000 m on
 * the serialized 6-decimal coordinates. Single-point alerts are exported only
 * for non-closure incidents with explicit bilateral direction
 * (`direction.value === "both"`).
 */

export interface CifsLane {
  order: number;
  type: "LANE";
  status: "OPEN" | "CLOSED";
}

export interface CifsSchedule {
  everyday?: string;
  monday?: string;
  tuesday?: string;
  wednesday?: string;
  thursday?: string;
  friday?: string;
  saturday?: string;
  sunday?: string;
}

export interface CifsSource {
  reference: string;
  name?: string;
  url?: string;
}

export interface CifsParentEvent {
  id: string;
}

export interface CifsIncident {
  id: string;
  parent_event?: CifsParentEvent;
  creationtime?: string;
  updatetime?: string;
  source?: CifsSource;
  type: Exclude<CifsType, "CONSTRUCTION" | "CHIT_CHAT">;
  subtype?: CifsXsdSubtype;
  description: string;
  street: string;
  polyline: string;
  direction: "ONE_DIRECTION" | "BOTH_DIRECTIONS";
  lanes?: CifsLane[];
  starttime?: string;
  endtime?: string;
  schedule?: CifsSchedule;
}

export interface CifsFeed {
  timestamp?: string;
  incidents: CifsIncident[];
}

/**
 * `xs:dateTime` in XML Schema 1.0 (as enforced by `xmllint-wasm`) rejects year
 * `0000`, so timestamps clamp to `[0001-01-01T00:00:00Z, 9999-12-31T23:59:59Z]`.
 */
const FIRST_WIRE_TIME = Date.parse("0001-01-01T00:00:00Z");
const LAST_WIRE_TIME = Date.parse("9999-12-31T23:59:59Z");

/** Maximum road closure polyline length Waze accepts (20 km). */
const MAX_CLOSURE_METERS = 20_000;

/** Closure scopes representing motor-vehicle road closures representable as CIFS ROAD_CLOSED. */
const ROAD_CLOSURE_SCOPES = new Set(["road", "carriageway", "ramp", "bridge", "tunnel"]);

/** Action statuses that are not confirmed and must never be exported even when scheduled. */
const UNCONFIRMED_SCHEDULED_ACTIONS = new Set(["rejected", "requested"]);

const SCHEDULE_DAY_KEYS = [
  ["MO", "monday"],
  ["TU", "tuesday"],
  ["WE", "wednesday"],
  ["TH", "thursday"],
  ["FR", "friday"],
  ["SA", "saturday"],
  ["SU", "sunday"],
] as const;

const ALL_ICAL_DAYS = SCHEDULE_DAY_KEYS.map(([code]) => code);

const FALLBACK_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ROAD_CLOSED: "Road closed",
  ROAD_CLOSED_CONSTRUCTION: "Road closed due to construction",
  ROAD_CLOSED_EVENT: "Road closed due to event",
  ROAD_CLOSED_HAZARD: "Road closed due to hazard",
  ACCIDENT: "Accident",
  ACCIDENT_MAJOR: "Major accident",
  ACCIDENT_MINOR: "Minor accident",
  HAZARD: "Road hazard",
  HAZARD_ON_ROAD_CONSTRUCTION: "Roadworks",
  HAZARD_ON_ROAD_LANE_CLOSED: "Lane closed",
  JAM: "Traffic jam",
  POLICE: "Police activity",
};

/** Unicode scalar value (code-point) length matching XML Schema `xs:minLength`. */
function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function wireTime(value: string): string {
  const ms = Date.parse(value);
  const clamped = Number.isFinite(ms)
    ? Math.min(Math.max(ms, FIRST_WIRE_TIME), LAST_WIRE_TIME)
    : FIRST_WIRE_TIME;
  return new Date(clamped).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = xmlChars(value).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Encodes an incident ID segment so root IDs (no `#`) and split IDs (`root#effect`)
 * occupy disjoint, poll-stable namespaces and XML 1.0 §3.3.3 attribute whitespace
 * normalization (`\t`, `\n`, `\r` → space) cannot collapse distinct IDs.
 */
function encodeIdPart(value: string): string {
  return xmlChars(value)
    .trim()
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/\t/g, "%09")
    .replace(/\n/g, "%0A")
    .replace(/\r/g, "%0D");
}

const firstText = (value: unknown): string | undefined =>
  cleanText((value as { text?: string }[] | undefined)?.[0]?.text);

function fmtCoord(n: number): string {
  const s = n.toFixed(6);
  return s === "-0.000000" ? "0.000000" : s;
}

function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Rec)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, item]) => [k, sort(item)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function validityKey(v: Validity): string {
  const start = v.start !== undefined ? Date.parse(v.start) : null;
  const end = v.end !== undefined ? Date.parse(v.end) : null;
  return canonicalJson({
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
    periods: v.periods ?? null,
    exceptions: v.exceptions ?? null,
  });
}

function directionKey(d: DirectionRef | undefined): string {
  return canonicalJson(d ?? null);
}

const hasOwnPlace = (effect: Effect): boolean =>
  (effect.location as { geometry?: unknown } | undefined)?.geometry != null;

function effectiveLocationOf(situation: Rec, effect?: Effect): Rec {
  const base = situation["location"] as Rec;
  if (!effect || !hasOwnPlace(effect)) return base;
  return { ...base, ...(effect.location as Rec) };
}

function effectiveDirectionOf(situation: Rec, effect?: Effect): DirectionRef | undefined {
  if (effect?.direction !== undefined) return effect.direction;
  if (effect?.location?.direction !== undefined) return effect.location.direction;
  return (situation["location"] as Rec | undefined)?.["direction"] as DirectionRef | undefined;
}

function parseHhMmExact(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] !== undefined ? Number(m[3]) : 0;
  if (sec !== 0 || h < 0 || h > 23 || min < 0 || min > 59) return undefined;
  return h * 60 + min;
}

function parseDurationMinutes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const minutes = m[3] ? Number(m[3]) : 0;
  const seconds = m[4] ? Number(m[4]) : 0;
  if (seconds !== 0) return undefined;
  const total = days * 1440 + hours * 60 + minutes;
  return total > 0 ? total : undefined;
}

function fmtHhMm(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Converts a model {@link Validity}'s recurring `periods` into a CIFS
 * `<schedule>`, or returns `"unsupported"` when the recurrence cannot be
 * represented faithfully without widening, DST drift, or timezone mismatch.
 */
function cifsScheduleOf(
  validity: Validity,
  geometry: Geometry | null | undefined,
): CifsSchedule | undefined | "unsupported" {
  if (validity.exceptions?.length) return "unsupported";
  const periods = validity.periods;
  if (!periods || periods.length === 0) return undefined;

  const geoTz = scheduleTimezoneForGeometry(geometry);
  if (!geoTz) return "unsupported";

  const overallStartDate =
    validity.start !== undefined && Number.isFinite(Date.parse(validity.start))
      ? localDateInZone(new Date(validity.start), geoTz)
      : undefined;
  const overallEndDate =
    validity.end !== undefined && Number.isFinite(Date.parse(validity.end))
      ? localDateInZone(new Date(validity.end), geoTz)
      : undefined;

  const byDay = new Map<string, Set<string>>();
  for (const code of ALL_ICAL_DAYS) byDay.set(code, new Set());

  for (const s of periods as Schedule[]) {
    if (s.scheduleTimezone !== geoTz) return "unsupported";
    if (
      s.exceptDate?.length ||
      s.byMonth?.length ||
      s.byMonthDay?.length ||
      s.repeatCount !== undefined
    ) {
      return "unsupported";
    }
    if (
      s.repeatFrequency !== undefined &&
      s.repeatFrequency !== "P1D" &&
      s.repeatFrequency !== "P1W"
    ) {
      return "unsupported";
    }
    // Reject sub-period date bounds narrower than the overall validity dates.
    if (
      s.startDate !== undefined &&
      (overallStartDate === undefined || s.startDate > overallStartDate)
    ) {
      return "unsupported";
    }
    if (s.endDate !== undefined && (overallEndDate === undefined || s.endDate < overallEndDate)) {
      return "unsupported";
    }

    const startMins = parseHhMmExact(s.startTime);
    if (startMins === undefined) return "unsupported";

    const durMins = s.duration !== undefined ? parseDurationMinutes(s.duration) : undefined;
    if (s.duration !== undefined && durMins === undefined) return "unsupported";

    const endTimeMins = s.endTime !== undefined ? parseHhMmExact(s.endTime) : undefined;
    if (s.endTime !== undefined && endTimeMins === undefined) return "unsupported";

    let endMins: number;
    if (durMins !== undefined) {
      // `duration` is authoritative in OpenConditions' Schedule contract.
      endMins = startMins + durMins;
      if (endTimeMins !== undefined && endTimeMins !== endMins) return "unsupported";
    } else if (endTimeMins !== undefined) {
      endMins = endTimeMins;
    } else {
      return "unsupported";
    }

    // Reject overnight, equal-endpoint, or >= 24:00 windows that CIFS cannot express cleanly.
    if (endMins <= startMins || endMins >= 24 * 60) return "unsupported";

    const days = s.byDay && s.byDay.length > 0 ? s.byDay : ALL_ICAL_DAYS;
    // Reject windows that cross a DST transition where fixed duration diverges from wall-clock endpoints.
    if (scheduleWindowCrossesDst(geoTz, startMins, endMins, days, validity.start, validity.end)) {
      return "unsupported";
    }

    const windowText = `${fmtHhMm(startMins)}-${fmtHhMm(endMins)}`;
    for (const d of days) {
      const bucket = byDay.get(d);
      if (!bucket) return "unsupported";
      bucket.add(windowText);
    }
  }

  const dayStrings = SCHEDULE_DAY_KEYS.map(([code, key]) => {
    const entries = [...byDay.get(code)!].sort();
    return [key, entries.length > 0 ? entries.join(",") : undefined] as const;
  });

  const nonEmpty = dayStrings.filter(([, text]) => text !== undefined);
  if (nonEmpty.length === 0) return "unsupported";

  const first = dayStrings[0]![1];
  if (first !== undefined && dayStrings.every(([, text]) => text === first)) {
    return { everyday: first };
  }

  // Emit strictly in cifsv2.xsd <xs:sequence> order: monday..sunday.
  const out: CifsSchedule = {};
  for (const [key, text] of dayStrings) {
    if (text !== undefined) out[key] = text;
  }
  return out;
}

interface SerializedGeometry {
  polyline: string;
  direction: "ONE_DIRECTION" | "BOTH_DIRECTIONS";
}

function serializeGeometryAndDirection(
  geometry: Geometry | null | undefined,
  direction: DirectionRef | undefined,
  isClosure: boolean,
  diagnostics: ProjectionDiagnostics,
  locationPath: string,
  directionPath: string,
  effect?: Effect,
  emitDiagnostics = true,
): SerializedGeometry | undefined {
  const report = (
    code: Parameters<ProjectionDiagnostics["emit"]>[0],
    path: string,
    message: string,
  ) => {
    if (emitDiagnostics) diagnostics.emit(code, "message", "withheld", path, message, effect);
  };

  if (!geometry) {
    report(
      "missing_geometry",
      `${locationPath}/geometry`,
      "This CIFS message is withheld: no usable geometry is available.",
    );
    return undefined;
  }

  if (geometry.type === "LineString") {
    let dir: "ONE_DIRECTION" | "BOTH_DIRECTIONS";
    let reverse = false;
    if (direction === undefined || direction.value === "both") {
      dir = "BOTH_DIRECTIONS";
    } else if (direction.basis === "geometry" && direction.value === "positive") {
      dir = "ONE_DIRECTION";
    } else if (direction.basis === "geometry" && direction.value === "negative") {
      dir = "ONE_DIRECTION";
      reverse = true;
    } else {
      report(
        "unrepresentable_direction",
        directionPath,
        "This CIFS message is withheld: CIFS cannot infer travel order from this direction.",
      );
      return undefined;
    }

    const rawCoords = reverse ? [...geometry.coordinates].reverse() : geometry.coordinates;
    const serialized: Array<{ latStr: string; lonStr: string; lat: number; lon: number }> = [];
    for (const pos of rawCoords) {
      const lon = pos[0];
      const lat = pos[1];
      if (typeof lon !== "number" || typeof lat !== "number") continue;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      const latStr = fmtCoord(lat);
      const lonStr = fmtCoord(lon);
      const prev = serialized.at(-1);
      if (prev !== undefined && prev.latStr === latStr && prev.lonStr === lonStr) continue;
      serialized.push({ latStr, lonStr, lat: Number(latStr), lon: Number(lonStr) });
    }

    if (serialized.length < 2) {
      report(
        "missing_geometry",
        `${locationPath}/geometry`,
        "This CIFS message is withheld: line collapses to fewer than two distinct vertices at 6-decimal precision.",
      );
      return undefined;
    }

    // Reject circular polylines (first serialized vertex === last serialized vertex for ≥ 3 vertices).
    const first = serialized[0]!;
    const last = serialized.at(-1)!;
    if (serialized.length >= 3 && first.latStr === last.latStr && first.lonStr === last.lonStr) {
      report(
        "missing_geometry",
        `${locationPath}/geometry`,
        "This CIFS message is withheld: circular polylines are not accepted by CIFS.",
      );
      return undefined;
    }

    let lengthMeters = 0;
    for (let i = 1; i < serialized.length; i++) {
      const a = serialized[i - 1]!;
      const b = serialized[i]!;
      lengthMeters += haversineMeters([a.lon, a.lat], [b.lon, b.lat]);
    }
    if (!(lengthMeters > 0)) {
      report(
        "missing_geometry",
        `${locationPath}/geometry`,
        "This CIFS message is withheld: serialized line has zero length.",
      );
      return undefined;
    }
    if (isClosure && lengthMeters > MAX_CLOSURE_METERS) {
      report(
        "missing_geometry",
        `${locationPath}/geometry`,
        "This CIFS closure is withheld: polyline exceeds CIFS 20 km closure length limit.",
      );
      return undefined;
    }

    return {
      polyline: serialized.map((p) => `${p.latStr} ${p.lonStr}`).join(" "),
      direction: dir,
    };
  }

  if (geometry.type === "Point") {
    if (isClosure) {
      report(
        "missing_geometry",
        `${locationPath}/geometry`,
        "This CIFS ROAD_CLOSED message is withheld: road closures require a LineString.",
      );
      return undefined;
    }
    // Single-point alerts are exported only with explicit bilateral evidence so
    // unstated or one-way points are never widened to BOTH_DIRECTIONS.
    if (direction?.value !== "both") {
      report(
        direction !== undefined ? "unrepresentable_direction" : "missing_geometry",
        direction !== undefined ? directionPath : `${locationPath}/geometry`,
        "This single-point CIFS alert is withheld: single-point alerts require explicit bilateral direction.",
      );
      return undefined;
    }
    const [lon, lat] = geometry.coordinates;
    if (
      typeof lon !== "number" ||
      typeof lat !== "number" ||
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      report(
        "missing_geometry",
        `${locationPath}/geometry`,
        "This CIFS message is withheld: point coordinates are out of range.",
      );
      return undefined;
    }
    return {
      polyline: `${fmtCoord(lat)} ${fmtCoord(lon)}`,
      direction: "BOTH_DIRECTIONS",
    };
  }

  report(
    "missing_geometry",
    `${locationPath}/geometry`,
    `This CIFS message is withheld: ${geometry.type} geometry cannot be represented as a CIFS polyline.`,
  );
  return undefined;
}

function closureSubtypeOf(situation: Rec): CifsXsdSubtype | undefined {
  const kind = String(situation["kind"] ?? "");
  if (kind === "roadworks") return "ROAD_CLOSED_CONSTRUCTION";
  if (kind === "public_event") return "ROAD_CLOSED_EVENT";
  if (kind === "road_hazard" || kind === "weather_condition" || kind === "road_condition") {
    return "ROAD_CLOSED_HAZARD";
  }
  return undefined;
}

function refineAccidentCode(situation: Rec, code: CifsIncidentCode): CifsIncidentCode {
  if (code.type !== "ACCIDENT" || code.subtype !== undefined) return code;
  const label = (situation["severity"] as { label?: string } | undefined)?.label;
  if (label === "major" || label === "critical") {
    return { type: "ACCIDENT", subtype: "ACCIDENT_MAJOR" };
  }
  if (label === "minor") {
    return { type: "ACCIDENT", subtype: "ACCIDENT_MINOR" };
  }
  return code;
}

function isPartialClosureVehicleImpact(
  impact: Extract<Effect, { kind: "lane_restriction" }>["vehicleImpact"],
): boolean {
  return (
    impact === "some_lanes_closed" ||
    impact === "some_lanes_closed_merge_left" ||
    impact === "some_lanes_closed_merge_right" ||
    impact === "some_lanes_closed_split"
  );
}

/**
 * Whether a `lane_restriction` effect carries affirmative, internally consistent
 * evidence that at least one lane is closed (eligible for
 * `HAZARD_ON_ROAD_LANE_CLOSED`). Rejects `all_lanes_open*` shifts, traffic
 * control impacts, and contradictory lane counts/lists.
 */
function isAffirmativeLaneClosure(effect: Extract<Effect, { kind: "lane_restriction" }>): boolean {
  if (effect.lanesClosed === 0 || effect.lanesRestricted === 0) return false;
  if (
    effect.lanesClosed !== undefined &&
    effect.lanesRestricted !== undefined &&
    effect.lanesRestricted < effect.lanesClosed
  ) {
    return false;
  }
  const raw = effect.lanes;
  let closedInList = 0;
  let openInList = 0;
  if (raw && raw.length > 0) {
    for (const lane of raw) {
      if (lane.status === "closed") closedInList++;
      else if (lane.status === "open") openInList++;
    }
    if (effect.lanesClosed !== undefined && closedInList > effect.lanesClosed) return false;
    if (effect.lanesRestricted !== undefined && closedInList > effect.lanesRestricted) {
      return false;
    }
    if (effect.lanesTotal !== undefined && raw.length === effect.lanesTotal && closedInList === 0) {
      return false;
    }
  }
  if (effect.vehicleImpact === "all_lanes_closed") {
    if (openInList > 0) return false;
    if (effect.lanesOperational !== undefined && effect.lanesOperational > 0) return false;
    if (
      effect.lanesTotal !== undefined &&
      effect.lanesClosed !== undefined &&
      effect.lanesClosed < effect.lanesTotal
    ) {
      return false;
    }
    return true;
  }
  if (isPartialClosureVehicleImpact(effect.vehicleImpact)) {
    return true;
  }
  if (effect.vehicleImpact === "unknown") {
    return (effect.lanesClosed ?? 0) > 0 || closedInList > 0;
  }
  return false;
}

/**
 * Extracts a full, contiguous `1..N` CIFS `<lanes>` layout only when the lane
 * array is complete, traffic-eligible, partial (both closed and open lanes),
 * and consistent with every declared lane count and `vehicleImpact` on the effect.
 */
function extractCompleteLanes(
  effect: Extract<Effect, { kind: "lane_restriction" }>,
): CifsLane[] | undefined {
  if (!isPartialClosureVehicleImpact(effect.vehicleImpact) && effect.vehicleImpact !== "unknown") {
    return undefined;
  }
  const raw = effect.lanes;
  if (!raw || raw.length === 0) return undefined;
  const sorted = [...raw].sort((a, b) => a.index - b.index);
  const out: CifsLane[] = [];
  let closedCount = 0;
  for (let i = 0; i < sorted.length; i++) {
    const lane = sorted[i]!;
    if (lane.index !== i + 1 || lane.index > 99) return undefined;
    if (lane.status !== "open" && lane.status !== "closed") return undefined;
    if (lane.type !== undefined && lane.type !== "general") return undefined;
    if (lane.status === "closed") closedCount++;
    out.push({
      order: lane.index,
      type: "LANE",
      status: lane.status === "closed" ? "CLOSED" : "OPEN",
    });
  }
  const openCount = out.length - closedCount;
  // CIFS <lanes> is only valid for partial closures (at least one closed and one open lane).
  if (closedCount === 0 || closedCount === out.length) return undefined;
  // Reconcile against declared counts so a partial or contradictory array is never emitted.
  if (effect.lanesTotal !== undefined && effect.lanesTotal !== out.length) return undefined;
  if (effect.lanesClosed !== undefined && effect.lanesClosed !== closedCount) return undefined;
  if (effect.lanesRestricted !== undefined && effect.lanesRestricted !== closedCount) {
    return undefined;
  }
  if (effect.lanesOperational !== undefined && effect.lanesOperational !== openCount) {
    return undefined;
  }
  return out;
}

function effectSemantics(effect: Effect, validity: Validity): string {
  const { id: _id, sourceRecordRef: _ref, source: _source, ...fields } = effect;
  return canonicalJson({ ...fields, validity: effectValidity(effect, validity) });
}

function laneStatementSignature(effect: Extract<Effect, { kind: "lane_restriction" }>): string {
  return canonicalJson({
    vehicleImpact: effect.vehicleImpact,
    lanesTotal: effect.lanesTotal ?? null,
    lanesClosed: effect.lanesClosed ?? null,
    lanesRestricted: effect.lanesRestricted ?? null,
    lanesOperational: effect.lanesOperational ?? null,
    lanes: effect.lanes ?? null,
  });
}

function sourceOf(situation: Rec): CifsSource | undefined {
  const prov = situation["provenance"] as Rec | undefined;
  const info = prov?.["informationSource"] as
    | { id?: string; name?: { text?: string }[] }
    | undefined;
  if (!info) return undefined;
  const name = firstText(info.name);
  const reference = cleanText(info.id) ?? name;
  if (!reference || codePointLength(reference) < 1) return undefined;
  return {
    reference,
    ...(name !== undefined && codePointLength(name) >= 1 ? { name } : {}),
  };
}

function parentEventOf(situation: Rec): CifsParentEvent | undefined {
  const externalIds = situation["externalIds"] as
    | Array<{ scheme?: string; id?: string }>
    | undefined;
  if (!Array.isArray(externalIds)) return undefined;
  for (const ext of externalIds) {
    if (ext?.scheme !== "cifs:parent_event") continue;
    const cleaned = cleanText(ext.id);
    if (cleaned !== undefined && codePointLength(cleaned) >= 3) {
      return { id: cleaned };
    }
  }
  return undefined;
}

function streetOf(location: Rec): string | undefined {
  const roads = location["roads"] as Rec[] | undefined;
  if (!roads || roads.length === 0) return undefined;
  for (const road of roads) {
    const name = firstText(road["name"]);
    if (name !== undefined && codePointLength(name) >= 2) return name;
    const ref = cleanText(road["ref"]);
    if (ref !== undefined && codePointLength(ref) >= 2) return ref;
  }
  return undefined;
}

function descriptionOf(situation: Rec, code: CifsIncidentCode): string {
  const desc = firstText(situation["description"]) ?? firstText(situation["headline"]);
  if (desc !== undefined && codePointLength(desc) >= 1) return desc;
  return (
    FALLBACK_DESCRIPTIONS[code.subtype ?? code.type] ??
    FALLBACK_DESCRIPTIONS[code.type] ??
    code.type
  );
}

interface CandidateBucket {
  isMain: boolean;
  rawId: string;
  splitEffectId?: string;
  location: Rec;
  locationPath: string;
  direction: DirectionRef | undefined;
  directionPath: string;
  validity: Validity;
  validityPath: string;
  effects: ProjectionEffect[];
  anchorEffect?: Effect;
}

interface LaneWindowClaim {
  bucketIndex: number;
  polyline: string;
  direction: "ONE_DIRECTION" | "BOTH_DIRECTIONS";
  validity: Validity;
  schedule: CifsSchedule | undefined;
  tz: string | undefined;
  signature: string;
}

interface BuiltCandidate {
  bucketIndex: number;
  incident: CifsIncident;
  bucket: CandidateBucket;
}

function addLocalDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function mondayZeroDay(dateStr: string): number {
  const utcDay = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return (utcDay + 6) % 7;
}

function parseScheduleMinutes(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const part of text.split(",")) {
    const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(part.trim());
    if (!m) continue;
    out.push([Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
  }
  return out;
}

function scheduleByDayIntervals(
  schedule: CifsSchedule | undefined,
): Array<Array<[number, number]>> {
  if (!schedule) {
    return Array.from({ length: 7 }, () => [[0, 24 * 60]]);
  }
  if (schedule.everyday !== undefined) {
    const wins = parseScheduleMinutes(schedule.everyday);
    return Array.from({ length: 7 }, () => wins);
  }
  return SCHEDULE_DAY_KEYS.map(([, key]) => {
    const text = schedule[key];
    return text !== undefined ? parseScheduleMinutes(text) : [];
  });
}

function effectiveWindowsOverlap(
  aValidity: Validity,
  aSchedule: CifsSchedule | undefined,
  aTz: string | undefined,
  bValidity: Validity,
  bSchedule: CifsSchedule | undefined,
  bTz: string | undefined,
): boolean {
  const aStart = aValidity.start !== undefined ? Date.parse(aValidity.start) : -Infinity;
  const aEnd = aValidity.end !== undefined ? Date.parse(aValidity.end) : Infinity;
  const bStart = bValidity.start !== undefined ? Date.parse(bValidity.start) : -Infinity;
  const bEnd = bValidity.end !== undefined ? Date.parse(bValidity.end) : Infinity;
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  if (!(overlapStart < overlapEnd)) return false;
  if (!aSchedule && !bSchedule) return true;

  const aDays = scheduleByDayIntervals(aSchedule);
  const bDays = scheduleByDayIntervals(bSchedule);
  const tz = aTz ?? bTz;
  // When the shared outer validity spans at most 14 days, intersect actual
  // localized occurrences clipped to [overlapStart, overlapEnd) so two weekly
  // schedules whose outer bounds overlap only on non-matching weekdays are not
  // falsely flagged as conflicting.
  if (
    tz !== undefined &&
    Number.isFinite(overlapStart) &&
    Number.isFinite(overlapEnd) &&
    overlapEnd - overlapStart <= 14 * 86_400_000
  ) {
    const firstDay = addLocalDays(localDateInZone(new Date(overlapStart), tz), -1);
    const lastDay = localDateInZone(new Date(overlapEnd - 1), tz);
    const occurrencesFor = (days: Array<Array<[number, number]>>): Array<[number, number]> => {
      const out: Array<[number, number]> = [];
      for (let day = firstDay; day <= lastDay; day = addLocalDays(day, 1)) {
        const dow = mondayZeroDay(day);
        for (const [s, e] of days[dow]!) {
          const startWall = `${fmtHhMm(s)}:00`;
          const endDay = e >= 24 * 60 ? addLocalDays(day, 1) : day;
          const endWall = e >= 24 * 60 ? "00:00:00" : `${fmtHhMm(e)}:00`;
          const t0 = zonedWallClockToInstant(tz, `${day}T${startWall}`)?.getTime();
          const t1 = zonedWallClockToInstant(tz, `${endDay}T${endWall}`)?.getTime();
          if (t0 === undefined || t1 === undefined) return [[overlapStart, overlapEnd]];
          const c0 = Math.max(t0, overlapStart);
          const c1 = Math.min(t1, overlapEnd);
          if (c0 < c1) out.push([c0, c1]);
        }
      }
      return out;
    };
    const aOcc = occurrencesFor(aDays);
    const bOcc = occurrencesFor(bDays);
    for (const [as, ae] of aOcc) {
      for (const [bs, be] of bOcc) {
        if (as < be && bs < ae) return true;
      }
    }
    return false;
  }

  for (let d = 0; d < 7; d++) {
    for (const [as, ae] of aDays[d]!) {
      for (const [bs, be] of bDays[d]!) {
        if (as < be && bs < ae) return true;
      }
    }
  }
  return false;
}

interface InternalIncidentResult {
  incident: CifsIncident;
  isSplit: boolean;
  rawSituationId: string;
  splitEffectId?: string;
}

function cifsIncidentsInternal(
  situation: Rec,
  at: Date,
  report?: ExportDiagnosticSink,
): InternalIncidentResult[] {
  const diagnostics = new ProjectionDiagnostics(situation, report);
  const blocked = diagnostics.blocked("cifs", {
    timing: (validity, effect) => {
      const loc = effectiveLocationOf(situation, effect);
      const geom = loc["geometry"] as Geometry | null | undefined;
      return cifsScheduleOf(validity, geom) !== "unsupported";
    },
  });
  if (blocked) return [];

  const rootValidity = situation["validity"] as Validity;
  const rootValidityKey = validityKey(rootValidity);
  const rootLocation = situation["location"] as Rec;
  const rootDirection = rootLocation["direction"] as DirectionRef | undefined;
  const rootDirectionKey = directionKey(rootDirection);
  const allEffects = projectionEffects(situation);

  const mainEffects: ProjectionEffect[] = [];
  const splitMap = new Map<string, ProjectionEffect[]>();

  for (const ctx of allEffects) {
    const ownPlace = hasOwnPlace(ctx.effect);
    const effDir = effectiveDirectionOf(situation, ctx.effect);
    const effDirKey = directionKey(effDir);
    const effValKey = validityKey(ctx.validity);
    if (!ownPlace && effValKey === rootValidityKey && effDirKey === rootDirectionKey) {
      mainEffects.push(ctx);
    } else {
      const placeKey = ownPlace ? canonicalJson(ctx.effect.location) : "__root__";
      const key = `${placeKey}|${effValKey}|${effDirKey}`;
      const list = splitMap.get(key) ?? [];
      list.push(ctx);
      splitMap.set(key, list);
    }
  }

  const rawSituationId = String(situation["id"]);
  const encodedSituationId = encodeIdPart(rawSituationId);
  const buckets: CandidateBucket[] = [
    {
      isMain: true,
      rawId: encodedSituationId,
      location: rootLocation,
      locationPath: "/location",
      direction: rootDirection,
      directionPath: "/location/direction",
      validity: rootValidity,
      validityPath: "/validity",
      effects: mainEffects,
    },
  ];

  const splitGroups = [...splitMap.values()];
  for (const group of splitGroups) {
    group.sort((a, b) => a.effect.id.localeCompare(b.effect.id));
  }
  splitGroups.sort((a, b) => a[0]!.effect.id.localeCompare(b[0]!.effect.id));

  for (const group of splitGroups) {
    const first = group[0]!;
    const ownPlace = hasOwnPlace(first.effect);
    const effPath = diagnostics.effectPath(first.effect);
    const directionPath =
      first.effect.direction !== undefined
        ? `${effPath}/direction`
        : first.effect.location?.direction !== undefined
          ? `${effPath}/location/direction`
          : "/location/direction";
    const encodedEffectId = encodeIdPart(first.effect.id);
    buckets.push({
      isMain: false,
      rawId:
        encodedSituationId.length > 0 && encodedEffectId.length > 0
          ? `${encodedSituationId}#${encodedEffectId}`
          : "",
      splitEffectId: first.effect.id,
      location: effectiveLocationOf(situation, first.effect),
      locationPath: ownPlace ? `${effPath}/location` : "/location",
      direction: effectiveDirectionOf(situation, first.effect),
      directionPath,
      validity: first.validity,
      validityPath: first.validityPath,
      effects: group,
      anchorEffect: first.effect,
    });
  }

  const natureCode = cifsIncidentCodeOf({
    kind: String(situation["kind"] ?? ""),
    type: String(situation["type"] ?? ""),
    ...(typeof situation["subtype"] === "string" ? { subtype: situation["subtype"] } : {}),
  });
  const managementOwned = allEffects.some(({ effect }) =>
    definesManagementNature(situation, effect),
  );
  const parentEvent = parentEventOf(situation);

  const built: BuiltCandidate[] = [];
  const laneClaims: LaneWindowClaim[] = [];

  for (const [bucketIndex, bucket] of buckets.entries()) {
    const active: ProjectionEffect[] = [];
    for (const ctx of bucket.effects) {
      const projected = projectionStateAt(ctx, at, false);
      const effPath = diagnostics.effectPath(ctx.effect);
      if (projected.state === "ended" || projected.state === "unknown") {
        diagnostics.emit(
          projected.state === "ended" ? "effect_ended" : "effect_time_unknown",
          "effect",
          "omitted",
          omittedPath(ctx, projected, effPath),
          `This effect is not exported at the evaluation instant: ${projected.state}.`,
          ctx.effect,
        );
        continue;
      }
      // Guard scheduled actions too: rejected or unapproved/requested actions must never export.
      if (
        projected.state === "scheduled" &&
        ctx.effect.actionStatus !== undefined &&
        UNCONFIRMED_SCHEDULED_ACTIONS.has(ctx.effect.actionStatus)
      ) {
        diagnostics.emit(
          "effect_time_unknown",
          "effect",
          "omitted",
          `${effPath}/actionStatus`,
          `This scheduled effect is not exported: actionStatus is ${ctx.effect.actionStatus}.`,
          ctx.effect,
        );
        continue;
      }
      active.push(ctx);
    }

    const closures = active.filter(
      (c): c is ProjectionEffect & { effect: Extract<Effect, { kind: "closure" }> } =>
        c.effect.kind === "closure",
    );
    const roadClosures: typeof closures = [];
    for (const c of closures) {
      const effPath = diagnostics.effectPath(c.effect);
      if (!ROAD_CLOSURE_SCOPES.has(c.effect.scope)) {
        diagnostics.emit(
          "unsupported_effect",
          "effect",
          "omitted",
          `${effPath}/scope`,
          `CIFS ROAD_CLOSED does not represent closure scope "${c.effect.scope}".`,
          c.effect,
        );
        continue;
      }
      if (c.effect.compliance !== "mandatory") {
        diagnostics.emit(
          "unsupported_effect",
          "effect",
          "omitted",
          `${effPath}/compliance`,
          `CIFS ROAD_CLOSED requires mandatory compliance; "${c.effect.compliance}" closures are not exported as full road closures.`,
          c.effect,
        );
        continue;
      }
      if (c.effect.laneScope && c.effect.laneScope.length > 0) {
        diagnostics.emit(
          "unsupported_effect",
          "effect",
          "omitted",
          `${effPath}/laneScope`,
          "CIFS ROAD_CLOSED applies to the full roadway and cannot represent a lane-scoped closure.",
          c.effect,
        );
        continue;
      }
      if (
        c.effect.normalization !== "complete" ||
        c.effect.applicability.kind !== "all" ||
        (c.effect.applicability.except?.length ?? 0) > 0
      ) {
        diagnostics.emit(
          "unsupported_effect",
          "effect",
          "omitted",
          effPath,
          "CIFS ROAD_CLOSED requires complete all-vehicle closure evidence.",
          c.effect,
        );
        continue;
      }
      roadClosures.push(c);
    }

    const laneEffects = active.filter(
      (c): c is ProjectionEffect & { effect: Extract<Effect, { kind: "lane_restriction" }> } =>
        c.effect.kind === "lane_restriction",
    );

    // Report other unsupported active effects in the bucket.
    for (const c of active) {
      if (c.effect.kind !== "closure" && c.effect.kind !== "lane_restriction") {
        diagnostics.emit(
          "unsupported_effect",
          "effect",
          "omitted",
          `${diagnostics.effectPath(c.effect)}/kind`,
          `This ${c.effect.kind} effect has no CIFS representation.`,
          c.effect,
        );
      }
    }

    // Detect conflicting distinct lane_restriction effects in the same bucket (including all_lanes_open).
    if (laneEffects.length > 1) {
      const distinct = new Set(laneEffects.map((c) => effectSemantics(c.effect, c.validity)));
      if (distinct.size > 1) {
        for (const c of laneEffects) {
          diagnostics.emit(
            "conflicting_effects",
            "message",
            "withheld",
            diagnostics.effectPath(c.effect),
            "This CIFS message is withheld: conflicting lane restrictions cannot be collapsed safely.",
            c.effect,
          );
        }
        continue;
      }
    }

    // Record every bucket's lane claim (including all_lanes_open) for cross-bucket overlap checks.
    const bucketGeometry = bucket.location["geometry"] as Geometry | null | undefined;
    const bucketSchedule = cifsScheduleOf(bucket.validity, bucketGeometry);
    if (laneEffects.length > 0 && bucketSchedule !== "unsupported") {
      const probeGeom = serializeGeometryAndDirection(
        bucketGeometry,
        bucket.direction,
        false,
        diagnostics,
        bucket.locationPath,
        bucket.directionPath,
        bucket.anchorEffect,
        false,
      );
      if (probeGeom) {
        laneClaims.push({
          bucketIndex,
          polyline: probeGeom.polyline,
          direction: probeGeom.direction,
          validity: bucket.validity,
          schedule: bucketSchedule,
          tz: scheduleTimezoneForGeometry(bucketGeometry) ?? undefined,
          signature: laneStatementSignature(laneEffects[0]!.effect),
        });
      }
    }

    let code: CifsIncidentCode | undefined;
    let isClosure = false;
    let attachLanesEffect: Extract<Effect, { kind: "lane_restriction" }> | undefined;

    if (roadClosures.length > 0) {
      isClosure = true;
      const subtype = closureSubtypeOf(situation);
      code = { type: "ROAD_CLOSED", ...(subtype !== undefined ? { subtype } : {}) };
      for (const c of laneEffects) {
        diagnostics.emit(
          "field_not_exported",
          "field",
          "omitted",
          diagnostics.effectPath(c.effect),
          "CIFS forbids partial lane data on ROAD_CLOSED incidents.",
          c.effect,
        );
      }
    } else {
      const closingLanes = laneEffects.find((c) => isAffirmativeLaneClosure(c.effect));
      if (bucket.isMain) {
        if (natureCode !== null && !managementOwned) {
          code = refineAccidentCode(situation, natureCode);
        } else if (closingLanes !== undefined) {
          code = { type: "HAZARD", subtype: "HAZARD_ON_ROAD_LANE_CLOSED" };
        } else if (natureCode === null && !managementOwned) {
          diagnostics.emit(
            "unsupported_nature",
            "field",
            "omitted",
            "/type",
            "This situation classification has no CIFS incident mapping.",
          );
        }
      } else if (closingLanes !== undefined) {
        code = { type: "HAZARD", subtype: "HAZARD_ON_ROAD_LANE_CLOSED" };
      }
      attachLanesEffect = closingLanes?.effect;
    }

    if (!code) continue;

    // ROAD_CLOSED requires an explicit validity.start (never invent from mutable poll times).
    if (isClosure && bucket.validity.start === undefined) {
      diagnostics.emit(
        "unsupported_timing",
        "message",
        "withheld",
        `${bucket.validityPath}/start`,
        "This CIFS ROAD_CLOSED message is withheld: road closures require an explicit validity.start.",
        bucket.anchorEffect,
      );
      continue;
    }

    const sanitizedId = bucket.rawId;
    if (sanitizedId.length === 0 || codePointLength(sanitizedId) < 3) {
      diagnostics.emit(
        "field_not_exported",
        "message",
        "withheld",
        "/id",
        "This CIFS message is withheld: incident id must be at least 3 code points after XML sanitization.",
        bucket.anchorEffect,
      );
      continue;
    }

    const street = streetOf(bucket.location);
    if (!street) {
      diagnostics.emit(
        "field_not_exported",
        "message",
        "withheld",
        `${bucket.locationPath}/roads`,
        "This CIFS message is withheld: CIFS requires a street name or road ref of at least 2 code points.",
        bucket.anchorEffect,
      );
      continue;
    }

    if (bucketSchedule === "unsupported") {
      diagnostics.emit(
        "unsupported_timing",
        "message",
        "withheld",
        `${bucket.validityPath}/periods`,
        "This CIFS message is withheld: schedule cannot be represented faithfully in CIFS.",
        bucket.anchorEffect,
      );
      continue;
    }

    const serialized = serializeGeometryAndDirection(
      bucketGeometry,
      bucket.direction,
      isClosure,
      diagnostics,
      bucket.locationPath,
      bucket.directionPath,
      bucket.anchorEffect,
    );
    if (!serialized) continue;

    let lanes: CifsLane[] | undefined;
    if (!isClosure && attachLanesEffect !== undefined) {
      const completeLanes =
        serialized.direction === "ONE_DIRECTION"
          ? extractCompleteLanes(attachLanesEffect)
          : undefined;
      if (completeLanes !== undefined) {
        lanes = completeLanes;
      } else {
        diagnostics.emit(
          "field_not_exported",
          "field",
          "omitted",
          diagnostics.effectPath(attachLanesEffect),
          "Partial lane counts, inconsistent totals, or bidirectional/non-contiguous lane data cannot be exported as CIFS <lanes> without fabricating roadside.",
          attachLanesEffect,
        );
      }
    }

    const provenance = situation["provenance"] as Rec | undefined;
    const sourceUpdatedAt =
      typeof provenance?.["sourceUpdatedAt"] === "string"
        ? wireTime(provenance["sourceUpdatedAt"])
        : undefined;
    const source = sourceOf(situation);

    const incident: CifsIncident = {
      id: sanitizedId,
      ...(parentEvent !== undefined ? { parent_event: parentEvent } : {}),
      ...(sourceUpdatedAt !== undefined ? { updatetime: sourceUpdatedAt } : {}),
      ...(source !== undefined ? { source } : {}),
      type: code.type,
      ...(code.subtype !== undefined ? { subtype: code.subtype } : {}),
      description: descriptionOf(situation, code),
      street,
      polyline: serialized.polyline,
      direction: serialized.direction,
      ...(lanes !== undefined ? { lanes } : {}),
      ...(bucket.validity.start !== undefined
        ? { starttime: wireTime(bucket.validity.start) }
        : {}),
      ...(bucket.validity.end !== undefined ? { endtime: wireTime(bucket.validity.end) } : {}),
      ...(bucketSchedule !== undefined ? { schedule: bucketSchedule } : {}),
    };

    built.push({ bucketIndex, incident, bucket });
  }

  // Withhold conflicting lane claims (including all_lanes_open) across overlapping
  // effective windows (intersecting recurring schedules) at the same place & direction.
  const conflictedBuckets = new Set<number>();
  for (let i = 0; i < laneClaims.length; i++) {
    for (let j = i + 1; j < laneClaims.length; j++) {
      const a = laneClaims[i]!;
      const b = laneClaims[j]!;
      if (a.signature === b.signature) continue;
      if (
        a.polyline === b.polyline &&
        a.direction === b.direction &&
        effectiveWindowsOverlap(a.validity, a.schedule, a.tz, b.validity, b.schedule, b.tz)
      ) {
        conflictedBuckets.add(a.bucketIndex);
        conflictedBuckets.add(b.bucketIndex);
      }
    }
  }

  const out: InternalIncidentResult[] = [];
  for (const item of built) {
    if (conflictedBuckets.has(item.bucketIndex)) {
      diagnostics.emit(
        "conflicting_effects",
        "message",
        "withheld",
        item.bucket.anchorEffect ? diagnostics.effectPath(item.bucket.anchorEffect) : "/effects",
        "This CIFS message is withheld: overlapping effective windows at the same location and direction state conflicting lane restrictions.",
        item.bucket.anchorEffect,
      );
      continue;
    }
    out.push({
      incident: item.incident,
      isSplit: !item.bucket.isMain,
      rawSituationId,
      ...(item.bucket.splitEffectId !== undefined
        ? { splitEffectId: item.bucket.splitEffectId }
        : {}),
    });
  }

  return out;
}

/**
 * Projects one canonical situation into zero or more CIFS v2 incidents at `at`.
 * Withholds situations or messages whose timing, geometry, direction, vehicle
 * scope, or lane restrictions cannot be represented faithfully in CIFS.
 */
export function cifsIncidentsOf(
  situation: Rec,
  at: Date,
  report?: ExportDiagnosticSink,
): CifsIncident[] {
  return cifsIncidentsInternal(situation, at, report).map((r) => r.incident);
}

function disambiguateFeedIds(results: InternalIncidentResult[]): CifsIncident[] {
  const rootIdCounts = new Map<string, number>();
  for (const r of results) {
    if (!r.isSplit) {
      rootIdCounts.set(r.incident.id, (rootIdCounts.get(r.incident.id) ?? 0) + 1);
    }
  }

  const used = new Set<string>();
  const out: CifsIncident[] = [];
  for (const r of results) {
    let id = r.incident.id;
    const collidesWithRoot = r.isSplit && rootIdCounts.has(id);
    const collidesWithUsed = used.has(id);
    const duplicateRoot = !r.isSplit && (rootIdCounts.get(id) ?? 0) > 1;
    if (collidesWithRoot || collidesWithUsed || duplicateRoot) {
      const seed = r.isSplit
        ? `split\0${r.rawSituationId}\0${r.splitEffectId ?? ""}`
        : `root\0${r.rawSituationId}`;
      let suffix = shortHash(seed);
      let candidate = `${id}~${suffix}`;
      let n = 1;
      while (used.has(candidate) || (r.isSplit && rootIdCounts.has(candidate))) {
        suffix = shortHash(`${seed}\0${n++}`);
        candidate = `${id}~${suffix}`;
      }
      id = candidate;
    }
    used.add(id);
    out.push(id === r.incident.id ? r.incident : { ...r.incident, id });
  }
  return out;
}

function scheduleToXml(schedule: CifsSchedule): Record<string, string> {
  // Preserve strict cifsv2.xsd <xs:sequence> element order.
  const out: Record<string, string> = {};
  if (schedule.everyday !== undefined) out["everyday"] = schedule.everyday;
  if (schedule.monday !== undefined) out["monday"] = schedule.monday;
  if (schedule.tuesday !== undefined) out["tuesday"] = schedule.tuesday;
  if (schedule.wednesday !== undefined) out["wednesday"] = schedule.wednesday;
  if (schedule.thursday !== undefined) out["thursday"] = schedule.thursday;
  if (schedule.friday !== undefined) out["friday"] = schedule.friday;
  if (schedule.saturday !== undefined) out["saturday"] = schedule.saturday;
  if (schedule.sunday !== undefined) out["sunday"] = schedule.sunday;
  return out;
}

function incidentToXml(incident: CifsIncident): Record<string, unknown> {
  return {
    "@_id": incident.id,
    ...(incident.parent_event !== undefined
      ? { parent_event: { "@_id": incident.parent_event.id } }
      : {}),
    ...(incident.creationtime !== undefined ? { creationtime: incident.creationtime } : {}),
    ...(incident.updatetime !== undefined ? { updatetime: incident.updatetime } : {}),
    ...(incident.source !== undefined
      ? {
          source: {
            reference: incident.source.reference,
            ...(incident.source.name !== undefined ? { name: incident.source.name } : {}),
            ...(incident.source.url !== undefined ? { url: incident.source.url } : {}),
          },
        }
      : {}),
    type: incident.type,
    ...(incident.subtype !== undefined ? { subtype: incident.subtype } : {}),
    description: incident.description,
    street: incident.street,
    polyline: incident.polyline,
    direction: incident.direction,
    ...(incident.lanes !== undefined
      ? {
          lanes: {
            lane: incident.lanes.map((l) => ({
              order: l.order,
              type: l.type,
              status: l.status,
            })),
          },
        }
      : {}),
    ...(incident.starttime !== undefined ? { starttime: incident.starttime } : {}),
    ...(incident.endtime !== undefined ? { endtime: incident.endtime } : {}),
    ...(incident.schedule !== undefined ? { schedule: scheduleToXml(incident.schedule) } : {}),
  };
}

/**
 * Projects situations to a CIFS v2 JSON feed (`{ timestamp?, incidents }`),
 * evaluated at `at`. Shares the exact same projection as {@link situationsToCifsXml}
 * and guarantees feed-wide incident ID uniqueness after XML sanitization.
 */
export function situationsToCifsJson(
  situations: readonly Rec[],
  at: Date = new Date(),
  info?: { timestamp?: string },
  report?: ExportDiagnosticSink,
): CifsFeed {
  const raw = situations.flatMap((situation) => cifsIncidentsInternal(situation, at, report));
  const incidents = disambiguateFeedIds(raw);
  const timestamp = info?.timestamp !== undefined ? wireTime(info.timestamp) : undefined;
  return {
    ...(timestamp !== undefined ? { timestamp } : {}),
    incidents,
  };
}

/**
 * Projects situations to a CIFS v2 XML `<incidents>` document conforming to
 * `cifsv2.xsd`, evaluated at `at`.
 */
export function situationsToCifsXml(
  situations: readonly Rec[],
  at: Date = new Date(),
  info?: { timestamp?: string },
  report?: ExportDiagnosticSink,
): string {
  const feed = situationsToCifsJson(situations, at, info, report);
  const root: Record<string, unknown> = {
    ...(feed.timestamp !== undefined ? { "@_timestamp": feed.timestamp } : {}),
    ...(feed.incidents.length > 0 ? { incident: feed.incidents.map(incidentToXml) } : {}),
  };
  return buildXmlDocument({ incidents: root });
}
