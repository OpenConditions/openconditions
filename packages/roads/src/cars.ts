import { type GeoJsonGeometry, scheduleTimezoneForGeometry } from "@openconditions/core";
import { recordSkipped } from "@openconditions/ingest-framework";
import { carsClassification, type RoadClassification } from "@openconditions/model-roads";
import type { LaneStatus, RoadEvent } from "./model.js";
import { buildLocalSchedule, jsDayToICal, type LocalSchedule, withTimezone } from "./schedule.js";
import { coarseOf } from "./situation/classes.js";
import {
  type RoadSnapshotRecord,
  type RoadSnapshotReport,
  reconcileRoadSnapshots,
  snapshotFingerprint,
} from "./snapshot.js";
import positiveDirections from "./snapshots/nysdot-positive-directions.json" with { type: "json" };
import type { SourceDescriptor } from "./types.js";

/**
 * Castle Rock's CARS events API (`/carsapi_v1/api/events`), the TMDD-based
 * successor of the IBI 511 API behind 511NY. The body is a JSON array of
 * events, each with its headline phrase, the publisher's description, a
 * priority, one detail element (times, phrases, further text, lanes, link
 * locations, recurring times) and the event's drawn geometry. Winter road
 * conditions are events of their own headline category; a segment that
 * reports nothing adverse is accounted for as ended, so an off-season
 * snapshot publishes no condition rather than failing.
 */

interface CarsTime {
  time?: number;
  timeZoneId?: string;
}

interface CarsPhrase {
  category?: string;
  code?: string;
}

interface CarsDescription {
  "description-type"?: string;
  kind?: CarsPhrase;
  description?: string;
}

interface CarsLocation {
  "location-type"?: string;
  "link-direction"?: string;
  "link-alignment"?: string;
  "route-designator"?: string;
  "segment-names"?: string[];
  "landmark-name"?: string;
}

interface CarsLanes {
  "lanes-type"?: string;
  "lanes-impact-type"?: string;
  "total-original"?: number;
  "total-affected"?: number;
  "lanes-affected"?: boolean[];
}

interface CarsRecurrentTime {
  period?: { "days-of-week"?: { bits?: number } };
  "schedule-times"?: {
    startTimeLT?: { hour?: number; minute?: number };
    stopTimeLT?: { hour?: number; minute?: number };
  }[];
}

interface CarsDetail {
  access?: string;
  "start-time"?: CarsTime;
  "end-time"?: CarsTime;
  "update-time"?: CarsTime;
  descriptions?: CarsDescription[];
  locations?: CarsLocation[];
  lanes?: CarsLanes[];
  "recurrent-times"?: CarsRecurrentTime[];
}

interface CarsEvent {
  "event-id"?: string;
  headline?: CarsPhrase;
  description?: string;
  priority?: number;
  "update-number"?: number;
  "update-time"?: CarsTime;
  status?: string;
  details?: CarsDetail[];
  geometry?: GeoJsonGeometry;
  counties?: string[];
}

const LANG = "en";

/** The headline category of a winter road condition segment. */
const ROAD_CONDITIONS = "nysdot-road-conditions";

/** Message statuses that end an event rather than state it. */
const ENDED_STATUSES = new Set([
  "ENDED",
  "CANCELLED",
  "CANCELED",
  "DELETED",
  "EXPIRED",
  "ARCHIVED",
]);

/** The access level of an event published for everyone; any other is withheld. */
const PUBLIC_ACCESS = "PUBLIC_DOMAIN";

/**
 * Winter condition codes that report nothing adverse: a clear road, or no
 * report from the segment's plow route yet.
 */
const NOMINAL_CONDITION =
  /^(no active reporting|update pending|no report|bare( pavement| and dry)?|dry|clear|good( winter driving)?( conditions)?)$/;

/** A winter condition code's classification, by the surface it names; undefined when nominal. */
function conditionClassification(code: string): RoadClassification | undefined {
  if (NOMINAL_CONDITION.test(code)) return undefined;
  if (/closed|impassable|travel not advised/.test(code)) {
    return { kind: "closure", type: "closure", subtype: "full" };
  }
  if (/ice|icy/.test(code)) return { kind: "road_condition", type: "surface", subtype: "icy" };
  if (/slush/.test(code)) return { kind: "road_condition", type: "surface", subtype: "slush" };
  if (/snow/.test(code))
    return { kind: "road_condition", type: "surface", subtype: "snow_covered" };
  if (/wet/.test(code)) return { kind: "road_condition", type: "surface", subtype: "wet" };
  return { kind: "road_condition", type: "surface" };
}

/** CARS priority 1 (most urgent) to 10, by 511NY's crosswalk: major 1, intermediate 3, minor 6. */
function severityOf(priority: number | undefined): RoadEvent["severity"] {
  if (priority === undefined || !Number.isInteger(priority) || priority < 1) return "unknown";
  if (priority === 1) return "high";
  if (priority <= 5) return "medium";
  return "low";
}

const instantOf = (t: CarsTime | undefined): string | undefined =>
  typeof t?.time === "number" && Number.isFinite(t.time)
    ? new Date(t.time).toISOString()
    : undefined;

/** The IANA zone the event states its times in. */
function zoneOf(detail: CarsDetail, event: CarsEvent): string | undefined {
  for (const t of [detail["start-time"], detail["end-time"], event["update-time"]]) {
    if (t?.timeZoneId?.includes("/")) return t.timeZoneId;
  }
  return undefined;
}

const OPPOSITE: Readonly<Record<string, string>> = { N: "S", S: "N", E: "W", W: "E" };
const ALIGNMENT: Readonly<Record<string, string>> = {
  NORTHBOUND: "N",
  SOUTHBOUND: "S",
  EASTBOUND: "E",
  WESTBOUND: "W",
};
const BOUND: Readonly<Record<string, string>> = {
  N: "northbound",
  S: "southbound",
  E: "eastbound",
  W: "westbound",
};
const POSITIVE: Readonly<Record<string, string>> = positiveDirections.routes;

/**
 * The travel direction a link location states: CARS gives it relative to the
 * route's positive direction, which the link's alignment names, else NYSDOT's
 * table of each route's positive direction.
 */
function directionOf(location: CarsLocation): string | undefined {
  const link = location["link-direction"];
  if (link === "BOTH_DIRECTIONS") return "both directions";
  if (link !== "POSITIVE_DIRECTION" && link !== "NEGATIVE_DIRECTION") return undefined;
  const route = location["route-designator"];
  const positive =
    ALIGNMENT[location["link-alignment"] ?? ""] ??
    (route === undefined ? undefined : POSITIVE[route]);
  if (positive === undefined) return undefined;
  return BOUND[link === "POSITIVE_DIRECTION" ? positive : OPPOSITE[positive]!];
}

/**
 * The lanes a closure takes: the first through-lane statement's counts and,
 * when it lists them, each lane's state. A closed shoulder takes no lane.
 */
function lanesOf(detail: CarsDetail): Pick<RoadEvent, "lanesAffected" | "roadState"> {
  const lanes = (detail.lanes ?? []).find(
    (l) => l["lanes-impact-type"] === "CLOSED" && !/SHOULDER/.test(l["lanes-type"] ?? ""),
  );
  if (lanes === undefined) return {};
  const total = lanes["total-original"];
  const closed = lanes["total-affected"];
  const each: LaneStatus[] = (lanes["lanes-affected"] ?? []).map((affected, i) => ({
    index: i + 1,
    status: affected ? "closed" : "open",
  }));
  const allClosed = total !== undefined && closed !== undefined && closed >= total;
  return {
    lanesAffected: {
      ...(total === undefined ? {} : { total }),
      ...(closed === undefined ? {} : { closed }),
      ...(each.length > 0 ? { lanes: each } : {}),
    },
    roadState:
      allClosed && lanes["lanes-type"] === "THROUGH_LANES" ? "closed" : "some_lanes_closed",
  };
}

const hhmm = (t: { hour?: number; minute?: number } | undefined): string | undefined =>
  t !== undefined && Number.isInteger(t.hour) && Number.isInteger(t.minute)
    ? `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`
    : undefined;

/**
 * The event's recurring active times: TMDD days of week as bits from Sunday
 * (bit 0) to Saturday, each with its daily local window, within the event's
 * span.
 */
function schedulesOf(
  detail: CarsDetail,
  validFrom: string | undefined,
  validTo: string | undefined,
): LocalSchedule[] | undefined {
  const out = (detail["recurrent-times"] ?? []).flatMap((r) => {
    const bits = r.period?.["days-of-week"]?.bits;
    const byDay =
      typeof bits === "number" && bits > 0 && bits < 127
        ? [0, 1, 2, 3, 4, 5, 6].flatMap((d) => ((bits >> d) & 1 ? [jsDayToICal(d)!] : []))
        : undefined;
    return (r["schedule-times"] ?? []).flatMap((t) => {
      const startTime = hhmm(t.startTimeLT);
      const endTime = hhmm(t.stopTimeLT);
      if (startTime === undefined || endTime === undefined) return [];
      return [
        buildLocalSchedule({
          ...(validFrom === undefined ? {} : { startDate: validFrom }),
          ...(validTo === undefined ? {} : { endDate: validTo }),
          startTime,
          endTime,
          ...(byDay === undefined ? {} : { byDay }),
        }),
      ];
    });
  });
  return out.length > 0 ? out : undefined;
}

const text = (value: string) => [{ lang: LANG, text: value }];

/**
 * The description's lead, `<road> <direction>: <phrase>`: CARS writes every
 * description as that sentence followed by the location, details and times.
 * A description of another shape is its own lead.
 */
function leadOf(description: string): string {
  const end = description.indexOf(". ");
  const lead = end < 0 ? description : description.slice(0, end);
  return lead.includes(": ") ? lead.replace(/\.$/, "") : description;
}

/** One event as its situation: the publisher's classification, place, times, lanes and text. */
function carsEvent(
  ev: CarsEvent,
  detail: CarsDetail,
  geometry: GeoJsonGeometry,
  classification: RoadClassification | undefined,
  condition: boolean,
  src: SourceDescriptor,
  fetchedAt: string,
): RoadEvent {
  const id = ev["event-id"]!;
  const coarse = coarseOf(classification);
  const links = (detail.locations ?? []).filter((l) => l["location-type"] === "LinkLocation");
  const roads = links.flatMap((l) => {
    const name = l["route-designator"];
    if (!name) return [];
    const direction = directionOf(l);
    return [{ name, ...(direction === undefined ? {} : { direction }) }];
  });
  const directions = new Set(roads.flatMap((r) => (r.direction ? [r.direction] : [])));
  const updated = instantOf(ev["update-time"]) ?? instantOf(detail["update-time"]);
  const validFrom = condition ? undefined : instantOf(detail["start-time"]);
  const validTo = condition ? undefined : instantOf(detail["end-time"]);
  const zone = zoneOf(detail, ev);
  const description = ev.description?.trim() || undefined;
  const comments = (detail.descriptions ?? []).flatMap((d) =>
    d["description-type"] === "AdditionalTextDescription" && d.description?.trim()
      ? [{ type: "public" as const, text: text(d.description.trim()) }]
      : [],
  );
  const severity = condition ? "unknown" : severityOf(ev.priority);
  const closure = classification?.kind === "closure";
  const lanes = lanesOf(detail);
  const lead = description === undefined ? undefined : leadOf(description);
  const headline = lead ?? roads[0]?.name ?? ev.headline?.code ?? coarse.type;
  const schedule = withTimezone(
    schedulesOf(detail, validFrom, validTo),
    zone ?? scheduleTimezoneForGeometry(geometry),
  );
  return {
    id: `${src.id}:${id}`,
    source: src.id,
    sourceFormat: "cars",
    domain: "roads",
    kind: "event",
    situation: {
      ...(classification === undefined ? {} : { classification }),
      ...(updated === undefined ? {} : { sourceUpdatedAt: updated }),
      ...(lead === undefined ? { headlineFromSource: false as const } : { headline: text(lead) }),
      ...(description === undefined ? {} : { description: text(description) }),
      ...(comments.length > 0 ? { comments } : {}),
      ...(ev.priority === undefined || condition ? {} : { severityRaw: String(ev.priority) }),
    },
    type: coarse.type,
    ...(ev.headline?.code ? { subtype: ev.headline.code } : {}),
    category: condition ? "conditions" : coarse.category,
    isPlanned: coarse.isPlanned,
    severity,
    severitySource: severity === "unknown" ? "derived" : "declared",
    status: "active",
    geometry,
    ...(directions.size === 1 ? { direction: [...directions][0] } : {}),
    roads,
    ...(closure && lanes.roadState === undefined ? { roadState: "closed" as const } : lanes),
    headline,
    ...(description === undefined ? {} : { description }),
    validFrom: validFrom ?? null,
    validTo: validTo ?? null,
    ...(schedule === undefined ? {} : { schedule }),
    ...(ev.counties && ev.counties.length > 0 ? { regions: [...ev.counties] } : {}),
    sourceRaw: ev as Record<string, unknown>,
    origin: {
      kind: "feed",
      attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
    },
    dataUpdatedAt: updated ?? fetchedAt,
    fetchedAt,
    isStale: false,
  };
}

/** Whether a geometry is GeoJSON this parser can place. */
function placeable(geometry: unknown): geometry is GeoJsonGeometry {
  if (geometry === null || typeof geometry !== "object") return false;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  return typeof g.type === "string" && Array.isArray(g.coordinates) && g.coordinates.length > 0;
}

/** Account for one event: ended, withheld or nominal events are terminal, the rest accepted. */
function carsRecord(
  raw: unknown,
  sourcePath: string,
  src: SourceDescriptor,
  fetchedAt: string,
): { record?: RoadSnapshotRecord; error?: RoadSnapshotReport["errors"][number] } {
  const ev = (raw !== null && typeof raw === "object" ? raw : {}) as CarsEvent;
  const localId = typeof ev["event-id"] === "string" ? ev["event-id"].trim() : "";
  if (localId === "") return { error: { code: "missing_identity", id: null, sourcePath } };
  const id = `${src.id}:${localId}`;
  const updateNumber = ev["update-number"];
  const version =
    typeof updateNumber === "number" && Number.isSafeInteger(updateNumber) && updateNumber >= 0
      ? updateNumber
      : null;
  const versionTime = instantOf(ev["update-time"]) ?? null;
  const detail = ev.details?.[0] ?? {};
  const category = ev.headline?.category?.trim().toLowerCase();
  const condition = category === ROAD_CONDITIONS;
  const code = ev.headline?.code?.trim().toLowerCase() ?? "";
  const classification = condition
    ? conditionClassification(code)
    : carsClassification(
        [
          ...(ev.headline?.code ? [ev.headline.code] : []),
          ...(detail.descriptions ?? []).flatMap((d) => (d.kind?.code ? [d.kind.code] : [])),
        ],
        category,
      );
  const terminal = ENDED_STATUSES.has((ev.status ?? "").toUpperCase())
    ? "ended"
    : detail.access !== undefined && detail.access !== PUBLIC_ACCESS
      ? "withheld"
      : condition && classification === undefined
        ? "nominal"
        : undefined;
  if (terminal !== undefined) {
    return {
      record: {
        id,
        version,
        versionTime,
        fingerprint: `terminal:${id}:${terminal}:${version ?? ""}:${versionTime ?? ""}`,
        disposition: "terminal",
      },
    };
  }
  if (!placeable(ev.geometry)) {
    return {
      record: {
        id,
        version,
        versionTime,
        fingerprint: `unlocatable:${id}`,
        disposition: "unlocatable",
      },
    };
  }
  const event = carsEvent(ev, detail, ev.geometry, classification, condition, src, fetchedAt);
  return {
    record: {
      id,
      version,
      versionTime,
      fingerprint: snapshotFingerprint(event),
      disposition: "accepted",
      event,
    },
  };
}

/**
 * Every event of one CARS response with its disposition, for a feed that
 * declares the response its complete snapshot. A body that is no event array
 * is an error, never an empty snapshot.
 */
export function parseCarsSnapshot(
  input: string | Buffer,
  src: SourceDescriptor,
  opts: { fetchedAt?: string } = {},
): RoadSnapshotReport {
  const fetchedAt = opts.fetchedAt ?? new Date().toISOString();
  let data: unknown;
  try {
    data = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return {
      inputCount: 0,
      records: [],
      errors: [{ code: "invalid_json", id: null, sourcePath: "$" }],
    };
  }
  if (!Array.isArray(data)) {
    return {
      inputCount: 0,
      records: [],
      errors: [{ code: "invalid_envelope", id: null, sourcePath: "$" }],
    };
  }
  const records: RoadSnapshotRecord[] = [];
  const errors: RoadSnapshotReport["errors"] = [];
  data.forEach((raw, index) => {
    const outcome = carsRecord(raw, `$[${index}]`, src, fetchedAt);
    if (outcome.error) errors.push(outcome.error);
    if (outcome.record) records.push(outcome.record);
  });
  const unlocatable = records.filter((r) => r.disposition === "unlocatable").length;
  if (unlocatable > 0) recordSkipped(src.id, "no_geometry", unlocatable);
  return { inputCount: data.length, records, errors };
}

/** The current events of one CARS response, for a feed that declares no complete snapshot. */
export function parseCars(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  const report = parseCarsSnapshot(input, src);
  for (const error of report.errors) {
    console.warn(`[cars] ${src.id}: ${error.code} at ${error.sourcePath}`);
  }
  return reconcileRoadSnapshots([{ ...report, errors: [] }]).observations as RoadEvent[];
}
