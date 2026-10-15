import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import type { VEHICLE_ACTIVITIES } from "@openconditions/model-vehicles";
import type { VehiclesCatalogFeed } from "../feed-schema.js";
import {
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
 * `UNKNOWN`. Every other task (mowing, brushing, inspections, signs, gravel
 * roads, lighting, `OTHER`) is work the vocabulary has no activity for; its
 * code stays on the reading's extras.
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
 * height Digitraffic appends, always 0, is dropped.
 */
function positionOf(geometry: unknown): [number, number] | undefined {
  if (!isRecord(geometry) || !Array.isArray(geometry["coordinates"])) return undefined;
  const coordinates = geometry["coordinates"] as unknown[];
  switch (geometry["type"]) {
    case "Point":
      return lonLat(coordinates);
    case "LineString":
    case "MultiPoint":
      return lonLat(coordinates.at(-1));
    default:
      return undefined;
  }
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
 * extra: a body that cannot be read gives none and is counted as rejected,
 * and the positions stand without trails.
 */
function routesOf(bodies: readonly Buffer[], out: Pick<ParseOutput, "rejected">) {
  const routes = new Map<string, Route>();
  for (const body of bodies) {
    let doc: unknown;
    try {
      doc = jsonOf(body, "the maintenance routes document");
    } catch {
      out.rejected = (out.rejected ?? 0) + 1;
      continue;
    }
    if (!isRecord(doc) || !Array.isArray(doc["features"])) {
      out.rejected = (out.rejected ?? 0) + 1;
      continue;
    }
    for (const feature of doc["features"]) {
      const props = isRecord(feature) ? feature["properties"] : undefined;
      if (!isRecord(props) || !isRecord(feature)) continue;
      const id = idOf(props["id"]);
      const endAt = Date.parse(typeof props["endTime"] === "string" ? props["endTime"] : "");
      const positions = positionsOf(feature["geometry"]);
      if (id === undefined || !Number.isFinite(endAt) || positions.length === 0) continue;
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
 * doing.
 *
 * Digitraffic groups the points by machine but publishes no machine id, and
 * the tracking id it does publish lives from a few seconds to a few minutes.
 * So no reading claims a vehicle; each is an anonymous position, transient,
 * standing until `MAX_POSITION_AGE_SEC` after the vehicle reported it, or
 * until a poll no longer restates it because the vehicle has moved on (the
 * format `restatesTransient`). A point already older than that at the fetch
 * is a vehicle that stopped reporting and is left out. A point without an
 * id, a time or a usable position is rejected and counted; a body that is no
 * feature collection fails the parse.
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
  const routes = routesOf(payloads["routes"] ?? [], out);
  for (const body of payloads["main"] ?? []) {
    const doc = jsonOf(body, "the maintenance tracking document");
    if (!isRecord(doc) || !Array.isArray(doc["features"])) {
      throw new Error("the maintenance tracking document carries no features");
    }
    for (const feature of doc["features"]) {
      const props = isRecord(feature) ? feature["properties"] : undefined;
      const id = isRecord(props) ? props["id"] : undefined;
      const stated = isRecord(props) && typeof props["time"] === "string" ? props["time"] : "";
      const point = isRecord(feature) ? positionOf(feature["geometry"]) : undefined;
      const time = Date.parse(stated);
      if (
        !isRecord(props) ||
        (typeof id !== "number" && typeof id !== "string") ||
        String(id).trim() === "" ||
        !Number.isFinite(time) ||
        point === undefined
      ) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      // A position cannot be newer than the fetch that read it: a later time is the fetch's.
      const at = Math.min(time, fetched);
      if (fetched - at > MAX_POSITION_AGE_SEC * 1000) continue;
      const bearing = bearingOf(props["direction"]);
      const source = typeof props["source"] === "string" ? props["source"].trim() : "";
      const trackingId = String(id).trim();
      const trail = trailOf(routes, trackingId, at, point);
      out.observations.push(
        positionReading(feed, ctx, {
          trackingId,
          at,
          point,
          tasks: tasksOf(props["tasks"]),
          ...(bearing === undefined ? {} : { bearing }),
          ...(source === "" ? {} : { source }),
          ...(trail === undefined ? {} : { trail }),
        }),
      );
    }
  }
  return out;
}
