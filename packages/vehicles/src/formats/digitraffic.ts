import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { VEHICLE_ACTIVITIES } from "@openconditions/model-vehicles";
import type { VehiclesCatalogFeed } from "../feed-schema.js";
import {
  epochOf,
  isRecord,
  jsonOf,
  lonLat,
  pointLocation,
  provenance,
  utcInstant,
  withObservationId,
} from "../records.js";

type Activity = (typeof VEHICLE_ACTIVITIES)[number];

/**
 * How long a position stands, from the time the vehicle reported it. Digitraffic
 * starts a new tracking after five minutes without a message and publishes a
 * message up to four minutes after the vehicle sent it, so a vehicle whose
 * latest point is older than this has stopped reporting. It is
 * `vehicle.position`'s freshness window.
 */
export const MAX_POSITION_AGE_SEC = 600;

/** What a task says the vehicle is doing, and which of its tools it says are working. */
interface TaskReading {
  activity?: Activity;
  /** The plough is down. */
  plow?: true;
  /** The spreader is spreading. */
  spreader?: true;
}

/**
 * The tasks of Digitraffic's list (`/api/maintenance/v1/tracking/tasks`) that
 * say something the position's vocabulary holds: ploughing with the blade
 * down, salting and sanding with the spreader on, and the publisher's own
 * `UNKNOWN`. The tasks of `UNREAD_TASKS` are work the vocabulary has no
 * activity for. Every task's code stays on the reading's extras.
 */
const TASKS: Readonly<Record<string, TaskReading>> = {
  PLOUGHING_AND_SLUSH_REMOVAL: { activity: "plowing", plow: true },
  PLOUGHING_OF_SLUSH_DITCH: { activity: "plowing", plow: true },
  LOWERING_OF_SNOWBANKS: { activity: "plowing", plow: true },
  SALTING: { activity: "salting", spreader: true },
  LINE_SANDING: { activity: "sanding", spreader: true },
  SPOT_SANDING: { activity: "sanding", spreader: true },
  UNKNOWN: { activity: "unknown" },
};

const WINTER =
  "winter work that is neither ploughing the carriageway nor spreading, which the activities do not name";
const SURFACE = "work on the road's surface or shoulders, which the activities do not name";
const ROADSIDE = "roadside and equipment upkeep, which the activities do not name";
const CHECK = "an inspection or a round, which the activities do not name";

/**
 * The other tasks of Digitraffic's list, each with why no activity is read
 * from it. `GARBAGE_OLLECTION` is the publisher's spelling. A task in neither
 * table is one the publisher added since, counted as a value not read.
 */
export const UNREAD_TASKS: Readonly<Record<string, string>> = {
  TRANSFER_OF_SNOW: WINTER,
  REMOVAL_OF_BULGE_ICE: WINTER,
  PREVENTING_MELTING_WATER_PROBLEMS: WINTER,
  SNOW_PLOUGHING_STICKS_AND_SNOW_FENCES: WINTER,
  BRUSHING: SURFACE,
  COMPACTION_BY_ROLLING: SURFACE,
  CRACK_FILLING: SURFACE,
  DUST_BINDING_OF_GRAVEL_ROAD_SURFACE: SURFACE,
  DUST_BINDING_OF_PAVED_ROAD_SURFACE: SURFACE,
  ENSURING_TRAFFIC_IN_RASPUTITSA: SURFACE,
  FILLING_OF_GRAVEL_ROAD_SHOULDERS: SURFACE,
  FILLING_OF_ROAD_SHOULDERS: SURFACE,
  HEATING: SURFACE,
  LEVELLING_GRAVEL_ROAD_SURFACE: SURFACE,
  LEVELLING_OF_ROAD_SHOULDERS: SURFACE,
  LEVELLING_OF_ROAD_SHOULDERS_UNDER_RAILING: SURFACE,
  LEVELLING_OF_ROAD_SURFACE: SURFACE,
  MIXING_OR_STABILIZATION: SURFACE,
  PATCHING: SURFACE,
  PAVING: SURFACE,
  RESHAPING_GRAVEL_ROAD_SURFACE: SURFACE,
  ROAD_MARKINGS: SURFACE,
  SPREADING_OF_CRUSH: SURFACE,
  BRUSH_CLEARING: ROADSIDE,
  CLEANSING_OF_BRIDGES: ROADSIDE,
  CLEANSING_OF_REST_AREAS: ROADSIDE,
  CLEANSING_OF_TRAFFIC_SIGNS: ROADSIDE,
  DITCHING: ROADSIDE,
  GARBAGE_OLLECTION: ROADSIDE,
  GROUP_REPLACEMENT_OF_LAMPS: ROADSIDE,
  MAINTENANCE_OF_GUIDE_SIGNS_AND_REFLECTOR_POSTS: ROADSIDE,
  MECHANICAL_CUT: ROADSIDE,
  OTHER_OPERATIONS_OF_LIGHTING_CONTRACTS: ROADSIDE,
  RENEWAL_OF_EDGE_COLUMNS: ROADSIDE,
  SAFETY_EQUIPMENT: ROADSIDE,
  CLIENTS_QUALITY_CONTROL: CHECK,
  ROAD_INSPECTIONS: CHECK,
  ROAD_STATE_CHECKING: CHECK,
  SERVICE_ROUND: CHECK,
  OTHER: "work the publisher does not name",
};

/** Which activity a tracking of several tasks reports: the first of these its tasks give. */
const ACTIVITY_ORDER: readonly Activity[] = ["plowing", "salting", "sanding", "unknown"];

/** The task codes of a tracking, trimmed; anything but a list of strings is no task. */
function tasksOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((task) => (typeof task === "string" && task.trim() ? [task.trim()] : []));
}

/** What the tasks of one tracking say about the vehicle, together. */
function readTasks(tasks: readonly string[]): Record<string, unknown> {
  const readings = tasks.flatMap((task) => {
    const reading = Object.hasOwn(TASKS, task) ? TASKS[task] : undefined;
    return reading === undefined ? [] : [reading];
  });
  const activity = ACTIVITY_ORDER.find((a) => readings.some((r) => r.activity === a));
  return {
    ...(activity === undefined ? {} : { activity }),
    ...(readings.some((r) => r.plow) ? { plowUp: false } : {}),
    ...(readings.some((r) => r.spreader) ? { spreaderOn: true } : {}),
  };
}

/** The heading of the tracking's last observation, in degrees from north; `null` or out of range is none. */
function bearingOf(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 360) {
    return undefined;
  }
  return value % 360;
}

/**
 * The tracking's latest position: a point, or the last position of a line or
 * of points (the endpoint answers points; its schema allows the others). The
 * height Digitraffic appends, always 0, is dropped. Without one, why as a
 * skip reason: `no_geometry` for no position, another geometry type or null
 * island, `malformed` for a position that is not one on the globe.
 */
function positionOf(
  geometry: unknown,
): { point: [number, number] } | { skip: "no_geometry" | "malformed" } {
  if (!isRecord(geometry) || !Array.isArray(geometry["coordinates"])) {
    return { skip: "no_geometry" };
  }
  const coordinates = geometry["coordinates"] as unknown[];
  let position: unknown;
  switch (geometry["type"]) {
    case "Point":
      position = coordinates;
      break;
    case "LineString":
    case "MultiPoint":
      position = coordinates.at(-1);
      break;
    default:
      return { skip: "no_geometry" };
  }
  const point = lonLat(position);
  if (point !== undefined) return { point };
  const [x, y] = Array.isArray(position) ? (position as unknown[]) : [];
  return { skip: x === undefined || (x === 0 && y === 0) ? "no_geometry" : "malformed" };
}

/** How far back a trail reaches: the trackings that ended within this of the vehicle's latest position. */
export const TRAIL_SEC = 600;

/** The most positions a trail keeps, its newest: a vehicle reporting every second for ten minutes stays bounded. */
const MAX_TRAIL_POSITIONS = 200;

/** One tracking of the `routes` document: the one before it, when it ended and the positions it joined. */
interface Route {
  previousId?: string;
  endAt: number;
  positions: [number, number][];
}

/** A geometry's usable positions, in order, without the height Digitraffic appends. */
function positionsOf(geometry: unknown): [number, number][] {
  if (!isRecord(geometry) || !Array.isArray(geometry["coordinates"])) return [];
  const coordinates = geometry["coordinates"] as unknown[];
  switch (geometry["type"]) {
    case "Point": {
      const p = lonLat(coordinates);
      return p === undefined ? [] : [p];
    }
    case "LineString":
    case "MultiPoint":
      return coordinates.flatMap((c) => {
        const p = lonLat(c);
        return p === undefined ? [] : [p];
      });
    default:
      return [];
  }
}

const idOf = (value: unknown): string | undefined =>
  (typeof value === "number" || typeof value === "string") && String(value).trim() !== ""
    ? String(value).trim()
    : undefined;

/**
 * The trackings of the `routes` documents by id. Trails are the reading's
 * extra: a body that cannot be read gives none and is skipped as malformed,
 * and the positions stand without trails. A tracking without an id or an end
 * time is skipped as malformed, one without a usable position as unplaced.
 */
function routesOf(feed: VehiclesCatalogFeed, bodies: readonly Buffer[]) {
  const routes = new Map<string, Route>();
  for (const body of bodies) {
    let doc: unknown;
    try {
      doc = jsonOf(body, "the maintenance routes document");
    } catch {
      recordSkipped(feed.id, "malformed");
      continue;
    }
    if (!isRecord(doc) || !Array.isArray(doc["features"])) {
      recordSkipped(feed.id, "malformed");
      continue;
    }
    for (const feature of doc["features"]) {
      const props = isRecord(feature) ? feature["properties"] : undefined;
      const id = isRecord(props) ? idOf(props["id"]) : undefined;
      const endAt = isRecord(props) ? epochOf(props["endTime"]) : undefined;
      if (!isRecord(feature) || !isRecord(props) || id === undefined || endAt === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const positions = positionsOf(feature["geometry"]);
      if (positions.length === 0) {
        recordSkipped(feed.id, "no_geometry");
        continue;
      }
      const previousId = idOf(props["previousId"]);
      routes.set(id, { endAt, positions, ...(previousId === undefined ? {} : { previousId }) });
    }
  }
  return routes;
}

/**
 * Where a vehicle has just been: the positions of its latest tracking and of
 * the trackings before it that each names (`previousId`), back to the first
 * that ended more than `TRAIL_SEC` before `at`, oldest first and ending at
 * `point`. Digitraffic links a tracking to the one before only while the
 * task stays the same and the vehicle keeps reporting, so a trail starts
 * at the last task change or silence. A tracking the routes do not hold
 * has no trail, nor has one that stood still.
 */
function trailOf(
  routes: ReadonlyMap<string, Route>,
  trackingId: string,
  at: number,
  point: [number, number],
): Record<string, unknown> | undefined {
  const parts: [number, number][][] = [];
  const seen = new Set<string>();
  for (let id: string | undefined = trackingId; id !== undefined && !seen.has(id); ) {
    seen.add(id);
    const route = routes.get(id);
    if (route === undefined || at - route.endAt > TRAIL_SEC * 1000) break;
    parts.unshift(route.positions);
    id = route.previousId;
  }
  if (parts.length === 0) return undefined;
  const positions: [number, number][] = [];
  for (const p of [...parts.flat(), point]) {
    const last = positions.at(-1);
    if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) positions.push(p);
  }
  const kept = positions.slice(-MAX_TRAIL_POSITIONS);
  return kept.length < 2 ? undefined : { type: "LineString", coordinates: kept };
}

/** One latest tracking point as an anonymous `vehicle.position` reading at its place. */
function positionReading(
  feed: VehiclesCatalogFeed,
  ctx: ParseContext,
  input: {
    trackingId: string;
    at: number;
    point: [number, number];
    tasks: string[];
    bearing?: number;
    source?: string;
    trail?: Record<string, unknown>;
  },
): RecordDraft {
  const geometry = { type: "Point", coordinates: [input.point[0], input.point[1]] };
  return withObservationId(feed, {
    class: "observation",
    kind: "observation",
    property: "vehicle.position",
    temporality: "live",
    location: pointLocation(input.point),
    provenance: provenance(feed, input.trackingId, input.source),
    freshness: {
      fetchedAt: ctx.fetchedAt,
      expiresAt: utcInstant(new Date(input.at + MAX_POSITION_AGE_SEC * 1000)),
    },
    subject: { kind: "location" },
    result: {
      type: "structured",
      schema: "vehicle_position",
      v: 1,
      value: {
        v: 1,
        point: geometry,
        ...(input.bearing === undefined ? {} : { bearingDeg: input.bearing }),
        ...readTasks(input.tasks),
        ...(input.trail === undefined ? {} : { trail: input.trail }),
      },
    },
    phenomenonTime: { instant: utcInstant(new Date(input.at)) },
    aggregation: "instantaneous",
    ...(input.tasks.length === 0 ? {} : { extras: { tasks: input.tasks } }),
  });
}

/**
 * Fintraffic's road maintenance tracking: the latest point of every work
 * machine (`/api/maintenance/v1/tracking/routes/latest`, the newest tracking
 * of each machine), each a `vehicle.position` reading at its location with
 * the bearing of its last observation and what its tasks say the vehicle is
 * doing. A task code outside the publisher's list is kept on the extras and
 * counted as a value not read.
 *
 * Digitraffic groups the points by machine but publishes no machine id, and
 * the tracking id it does publish lives from a few seconds to a few minutes.
 * So no reading claims a vehicle; each is an anonymous position, transient,
 * standing until `MAX_POSITION_AGE_SEC` after the vehicle reported it, or
 * until a poll no longer restates it because the vehicle has moved on (the
 * format `restatesTransient`). A point already older than that at the fetch
 * is a vehicle that stopped reporting and is left out. A point without an
 * id or a time is skipped as malformed, one without a usable position as
 * unplaced (`positionOf`); a body that is no feature collection fails the
 * parse.
 *
 * The optional `routes` role (`/api/maintenance/v1/tracking/routes` over the
 * last ten minutes) gives each position its trail: where the vehicle has
 * just been, as `trailOf` joins it.
 */
export function parseDigitrafficMaintenance(
  feed: VehiclesCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const fetched = Date.parse(ctx.fetchedAt);
  const routes = routesOf(feed, payloads["routes"] ?? []);
  for (const body of payloads["main"] ?? []) {
    const doc = jsonOf(body, "the maintenance tracking document");
    if (!isRecord(doc) || !Array.isArray(doc["features"])) {
      throw new Error("the maintenance tracking document carries no features");
    }
    for (const feature of doc["features"]) {
      const props = isRecord(feature) ? feature["properties"] : undefined;
      const id = isRecord(props) ? props["id"] : undefined;
      const time = isRecord(props) ? epochOf(props["time"]) : undefined;
      if (
        !isRecord(feature) ||
        !isRecord(props) ||
        (typeof id !== "number" && typeof id !== "string") ||
        String(id).trim() === "" ||
        time === undefined
      ) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const position = positionOf(feature["geometry"]);
      if ("skip" in position) {
        recordSkipped(feed.id, position.skip);
        continue;
      }
      const { point } = position;
      // A position cannot be newer than the fetch that read it: a later time is the fetch's.
      const at = Math.min(time, fetched);
      if (fetched - at > MAX_POSITION_AGE_SEC * 1000) continue;
      const bearing = bearingOf(props["direction"]);
      const source = typeof props["source"] === "string" ? props["source"].trim() : "";
      const trackingId = String(id).trim();
      const trail = trailOf(routes, trackingId, at, point);
      const tasks = tasksOf(props["tasks"]);
      recordSkipped(
        feed.id,
        "unknown_value",
        tasks.filter((t) => !Object.hasOwn(TASKS, t) && !Object.hasOwn(UNREAD_TASKS, t)).length,
      );
      out.observations.push(
        positionReading(feed, ctx, {
          trackingId,
          at,
          point,
          tasks,
          ...(bearing === undefined ? {} : { bearing }),
          ...(source === "" ? {} : { source }),
          ...(trail === undefined ? {} : { trail }),
        }),
      );
    }
  }
  return out;
}
