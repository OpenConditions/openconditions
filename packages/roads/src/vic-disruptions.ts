import { toIsoTimestamp } from "@openconditions/core";
import { recordSkipped } from "@openconditions/ingest-framework";
import { type Schedule, Schedule as ScheduleSchema } from "@openconditions/model";
import { VIC_SITUATIONS, vicClassification } from "@openconditions/model-roads";
import type { Geometry } from "geojson";
import { dedupeRoadEvents } from "./dedupe.js";
import type { RoadEvent, RoadEventType } from "./model.js";
import { entryOf, usableGeometry } from "./situation/location.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Transport Victoria's two road-disruption datasets. They share a server and an
 * auth scheme but not a shape, so one parser handles both and discriminates on
 * the envelope: planned v1 returns `{ disruptions: [...] }` with a
 * GeometryCollection-shaped geometry and a recurrence schedule; unplanned v2
 * returns a plain `{ type: "FeatureCollection", features: [...] }`.
 */
const TIMEZONE = "Australia/Melbourne";

/** iCal two-letter day codes, indexed the way the planned feed numbers days. */
const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/**
 * The disruption vocabularies both datasets draw on. Values not listed degrade
 * to `other`, which still reaches the map with its own headline rather than
 * being dropped.
 */
const TYPE_BY_EVENT: Record<string, RoadEventType> = {
  roadworks: "roadworks",
  "road works": "roadworks",
  maintenance: "roadworks",
  construction: "roadworks",
  "special event": "public_event",
  event: "public_event",
  crash: "accident",
  accident: "accident",
  collision: "accident",
  incident: "accident",
  hazard: "hazard",
  "fallen tree": "hazard",
  "traffic hazard": "hazard",
  flooding: "weather",
  weather: "weather",
  fire: "hazard",
  closure: "road_closure",
  "road closure": "road_closure",
  congestion: "congestion",
};

type Record_ = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (typeof v === "number") return String(v);
  return undefined;
}

function obj(v: unknown): Record_ | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record_) : undefined;
}

/**
 * Whether a record that names an event type or subtype names none the
 * crosswalk knows, `others` being further tokens that may classify it.
 */
function unknownEventType(
  named: readonly (string | undefined)[],
  others: readonly (string | undefined)[] = [],
): boolean {
  return (
    named.some((c) => c !== undefined) &&
    ![...named, ...others].some(
      (c) => c !== undefined && Object.hasOwn(VIC_SITUATIONS, c.trim().toLowerCase()),
    )
  );
}

function resolveType(...candidates: (string | undefined)[]): RoadEventType {
  for (const c of candidates) {
    if (!c) continue;
    const hit = entryOf(TYPE_BY_EVENT, c.toLowerCase());
    if (hit) return hit;
  }
  return "other";
}

/**
 * Unwrap the planned feed's geometry: it nests the real shape inside a
 * `geometries[]` array. A single entry is used directly; several become a
 * GeometryCollection, which the downstream projection already handles.
 */
function unwrapGeometry(raw: unknown): Geometry | undefined {
  const g = obj(raw);
  if (!g) return undefined;
  const nested = g.geometries;
  if (Array.isArray(nested)) {
    const shapes = nested.map(usableGeometry).filter((n) => n !== undefined);
    if (shapes.length === 0) return undefined;
    return shapes.length === 1 ? shapes[0] : { type: "GeometryCollection", geometries: shapes };
  }
  return usableGeometry(g);
}

/**
 * Map one `duration.recurrences[]` entry to the canonical Schedule. The feed
 * gives a first day plus a span in days, which becomes the `byDay` set; times
 * stay local to Melbourne, as the canonical model expects. Undefined when the
 * entry states no recurrence, null when it states one in values the model
 * cannot hold (a time of day or duration that is none).
 */
function toSchedule(
  raw: Record_,
  startDate?: string,
  endDate?: string,
): Schedule | null | undefined {
  const startDay = Number(raw.startDay);
  const days = Number(raw.daysDuration);
  const byDay: string[] = [];
  if (Number.isInteger(startDay) && startDay >= 0) {
    const span = Number.isInteger(days) && days > 0 ? Math.min(days, 7) : 1;
    for (let i = 0; i < span; i++) byDay.push(DAY_CODES[(startDay + i) % 7]!);
  }
  const startTime = str(raw.startTime);
  const duration = str(raw.duration);
  const allDay = raw.allDay === true;
  if (byDay.length === 0 && !startTime && !duration && !allDay) return undefined;
  const schedule: Schedule = {
    scheduleTimezone: TIMEZONE,
    ...(byDay.length > 0 ? { byDay } : {}),
    ...(startDate ? { startDate: startDate.slice(0, 10) } : {}),
    ...(endDate ? { endDate: endDate.slice(0, 10) } : {}),
    ...(allDay ? { startTime: "00:00", duration: "P1D" } : {}),
    ...(!allDay && startTime ? { startTime } : {}),
    ...(!allDay && duration ? { duration } : {}),
  };
  return ScheduleSchema.safeParse(schedule).success ? schedule : null;
}

function baseEvent(
  src: SourceDescriptor,
  id: string,
  geometry: Geometry,
  now: string,
): Pick<
  RoadEvent,
  | "id"
  | "source"
  | "sourceFormat"
  | "domain"
  | "kind"
  | "status"
  | "geometry"
  | "severity"
  | "severitySource"
  | "origin"
  | "fetchedAt"
  | "isStale"
> {
  return {
    id: `${src.id}:${id}`,
    source: src.id,
    sourceFormat: "vic-disruptions",
    domain: "roads",
    kind: "event",
    status: "active",
    geometry,
    severity: "unknown",
    severitySource: "derived",
    origin: {
      kind: "feed",
      attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
    },
    fetchedAt: now,
    isStale: false,
  };
}

function parsePlanned(records: unknown[], src: SourceDescriptor, now: string): RoadEvent[] {
  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;
  let malformed = 0;
  let unknownValues = 0;
  for (const raw of records) {
    const r = obj(raw);
    if (!r) {
      malformed++;
      continue;
    }
    const id = str(r.id) ?? str(r.disruptionId) ?? str(r.eventId);
    const geometry = unwrapGeometry(r.geometry);
    if (!geometry) {
      skippedNoGeometry++;
      continue;
    }
    if (!id) {
      malformed++;
      continue;
    }

    const duration = obj(r.duration);
    const validFrom = toIsoTimestamp(duration?.start, src.timeZone);
    const validTo = toIsoTimestamp(duration?.end, src.timeZone);
    const recurrences = Array.isArray(duration?.recurrences) ? duration.recurrences : [];
    const read = recurrences.map((rec) =>
      obj(rec) ? toSchedule(obj(rec)!, str(duration?.start), str(duration?.end)) : undefined,
    );
    unknownValues += read.filter((s) => s === null).length;
    const schedule = read.filter((s): s is Schedule => s != null);

    const impact = obj(r.impact);
    const lanesClosed = Number(impact?.numberLanesImpacted);
    const speedLimit = Number(impact?.speedLimitOnSite);
    const delay = Number(impact?.delay);
    const direction = str(impact?.direction);
    const road = str(r.roadName) ?? str(r.road);

    const recordTime = toIsoTimestamp(r.lastUpdated, src.timeZone);
    const tokens = [str(r.eventSubtype), str(r.eventType), str(impact?.impactType)];
    const classification = vicClassification(...tokens);
    if (unknownEventType(tokens.slice(0, 2), tokens.slice(2))) unknownValues++;
    out.push({
      ...baseEvent(src, id, geometry, now),
      situation: {
        ...(classification !== undefined ? { classification } : {}),
        ...(recordTime !== undefined ? { sourceUpdatedAt: recordTime } : {}),
        ...((str(r.name) ?? str(r.title) ?? str(r.description) ?? road)
          ? {}
          : { headlineFromSource: false as const }),
      },
      type: resolveType(...tokens),
      subtype: str(r.eventSubtype) ?? str(r.eventType),
      category: "planned",
      isPlanned: true,
      roads: road ? [{ name: road, ...(direction ? { direction } : {}) }] : [],
      ...(Number.isFinite(lanesClosed) && lanesClosed > 0
        ? { lanesAffected: { closed: lanesClosed } }
        : {}),
      ...(Number.isFinite(speedLimit) && speedLimit > 0 ? { speedLimitKph: speedLimit } : {}),
      ...(Number.isFinite(delay) && delay > 0 ? { delaySeconds: delay } : {}),
      headline: str(r.name) ?? str(r.title) ?? str(r.description) ?? road ?? "Planned disruption",
      description: str(r.description),
      validFrom: validFrom ?? null,
      validTo: validTo ?? null,
      ...(schedule.length > 0 ? { schedule } : {}),
      sourceRaw: r,
      dataUpdatedAt: toIsoTimestamp(r.lastUpdated, src.timeZone) ?? validFrom ?? now,
    });
  }
  if (skippedNoGeometry > 0) {
    console.debug(
      `[vic-disruptions] ${src.id}: skipped ${skippedNoGeometry} record(s) with no usable geometry`,
    );
    recordSkipped(src.id, "no_geometry", skippedNoGeometry);
  }
  recordSkipped(src.id, "malformed", malformed);
  recordSkipped(src.id, "unknown_value", unknownValues);
  return out;
}

function parseUnplanned(features: unknown[], src: SourceDescriptor, now: string): RoadEvent[] {
  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;
  let malformed = 0;
  let unknownValues = 0;
  for (const raw of features) {
    const f = obj(raw);
    if (!f) {
      malformed++;
      continue;
    }
    const p = obj(f.properties) ?? {};
    const id = str(p.id) ?? str(f.id) ?? str(p.eventId);
    const geometry = usableGeometry(f.geometry);
    if (!geometry) {
      skippedNoGeometry++;
      continue;
    }
    if (!id) {
      malformed++;
      continue;
    }

    const eventType = str(p.eventType);
    const eventSubType = str(p.eventSubType) ?? str(p.eventSubtype);
    const road = str(p.roadName) ?? str(p.road);
    const direction = str(p.direction);
    const type = resolveType(eventSubType, eventType, str(p.status));
    const classification = vicClassification(eventSubType, eventType, str(p.status));
    if (unknownEventType([eventSubType, eventType], [str(p.status)])) unknownValues++;
    const recordTime =
      toIsoTimestamp(p.lastUpdated, src.timeZone) ?? toIsoTimestamp(p.created, src.timeZone);

    out.push({
      ...baseEvent(src, id, geometry, now),
      situation: {
        ...(classification !== undefined ? { classification } : {}),
        ...(recordTime !== undefined ? { sourceUpdatedAt: recordTime } : {}),
        ...((str(p.name) ?? str(p.title) ?? str(p.description) ?? road)
          ? {}
          : { headlineFromSource: false as const }),
      },
      type,
      subtype: eventSubType ?? eventType,
      category: "incident",
      isPlanned: false,
      roads: road ? [{ name: road, ...(direction ? { direction } : {}) }] : [],
      headline: str(p.name) ?? str(p.title) ?? str(p.description) ?? road ?? "Road disruption",
      description: str(p.description),
      validFrom: toIsoTimestamp(p.created, src.timeZone) ?? null,
      validTo: toIsoTimestamp(p.endTime, src.timeZone) ?? null,
      sourceRaw: p,
      dataUpdatedAt:
        toIsoTimestamp(p.lastUpdated, src.timeZone) ??
        toIsoTimestamp(p.created, src.timeZone) ??
        now,
    });
  }
  if (skippedNoGeometry > 0) {
    console.debug(
      `[vic-disruptions] ${src.id}: skipped ${skippedNoGeometry} record(s) with no usable geometry`,
    );
    recordSkipped(src.id, "no_geometry", skippedNoGeometry);
  }
  recordSkipped(src.id, "malformed", malformed);
  recordSkipped(src.id, "unknown_value", unknownValues);
  return out;
}

/**
 * Parse either Victoria disruption dataset into RoadEvents. Records without
 * usable geometry are left out and counted as such; records that are no
 * object or have no id as malformed. An event type or subtype the crosswalk
 * does not know, and a recurrence in values the model cannot hold, is counted
 * as an unknown value. A malformed body yields [].
 *
 * The planned dataset paginates by `nextPageDetails.nextPageToken`, which the
 * fetch layer's offset pagination cannot express. Rather than truncating
 * silently, a response that reports more records logs a warning.
 */
export function parseVicDisruptions(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return [];
  }
  const body = obj(payload);
  if (!body) return [];
  const now = new Date().toISOString();

  const nextPage = obj(body.nextPageDetails);
  if (nextPage?.hasMoreRecords === true) {
    console.warn(
      `[vic-disruptions] ${src.id}: the response reports more records than one page returns; token pagination is not wired, so coverage is truncated`,
    );
  }

  if (Array.isArray(body.disruptions)) {
    return dedupeRoadEvents(parsePlanned(body.disruptions, src, now));
  }
  if (Array.isArray(body.features)) {
    return dedupeRoadEvents(parseUnplanned(body.features, src, now));
  }
  return [];
}
