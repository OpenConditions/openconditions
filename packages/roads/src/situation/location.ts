import { type DirectionRef, Geometry, type Text } from "@openconditions/model";
import type { RoadEvent, RoadRef } from "../model.js";
import type { SnapshotEvent } from "../snapshot.js";
import type { SourceDescriptor } from "../types.js";

/** Language of source text whose language the parser does not know (BCP 47 "undetermined"). */
export const UNDETERMINED = "und";

/**
 * A published GeoJSON geometry the model can hold, reduced to its shape:
 * a known type, coordinates within range, lines of two positions and
 * closed rings. Members beside the shape, such as a `bbox`, are dropped.
 * Undefined for anything else, which places nothing.
 */
export function usableGeometry(value: unknown): Geometry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const g = value as Record<string, unknown>;
  const shape =
    g["type"] === "GeometryCollection"
      ? {
          type: g["type"],
          geometries: Array.isArray(g["geometries"])
            ? g["geometries"].map((m: unknown) =>
                m !== null && typeof m === "object"
                  ? {
                      type: (m as Record<string, unknown>)["type"],
                      coordinates: (m as Record<string, unknown>)["coordinates"],
                    }
                  : m,
              )
            : g["geometries"],
        }
      : { type: g["type"], coordinates: g["coordinates"] };
  const parsed = Geometry.safeParse(shape);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A table's own entry for a source token. Source text is not trusted to name
 * an entry: an inherited key such as `constructor` or `toString` is none.
 */
export function entryOf<T>(
  table: Readonly<Record<string, T>>,
  key: string | null | undefined,
): T | undefined {
  return key != null && Object.hasOwn(table, key) ? table[key] : undefined;
}

export function text(value: string | undefined): Text | undefined {
  const trimmed = value?.trim();
  return trimmed ? [{ lang: UNDETERMINED, text: trimmed }] : undefined;
}

const ROAD_CLASSES: Record<string, string> = {
  motorway: "motorway",
  trunk: "trunk",
  primary: "primary",
  secondary: "secondary",
  tertiary: "tertiary",
  local: "local",
  residential: "local",
  unclassified: "local",
  service: "service",
};

const COMPASS: Record<string, DirectionRef["compass"]> = {
  n: "N",
  north: "N",
  northbound: "N",
  nb: "N",
  ne: "NE",
  e: "E",
  east: "E",
  eastbound: "E",
  eb: "E",
  se: "SE",
  s: "S",
  south: "S",
  southbound: "S",
  sb: "S",
  sw: "SW",
  w: "W",
  west: "W",
  westbound: "W",
  wb: "W",
  nw: "NW",
};

/** Ring-road loops as sources write them (WZDx `inner-loop`, `outer-loop`). */
const LOOPS: Record<string, DirectionRef["loop"]> = {
  "inner-loop": "inner",
  "inner loop": "inner",
  "outer-loop": "outer",
  "outer loop": "outer",
};

const BOTH = new Set([
  "both",
  "beidseitig",
  "beide richtungen",
  "in beiden richtungen",
  "bothways",
  "both ways",
  "both directions",
  "b",
  "all",
  "all directions",
]);

/**
 * A parser's free-text direction as a DirectionRef. A bearing becomes basis
 * `bearing`, a compass token basis `compass`, an Alert-C direction on a
 * TMC-located event basis `alert_c`, a ring road's inner or outer loop its
 * `loop` beside the verbatim text; anything else stays verbatim text with
 * value `unknown` (or `both` when it says so). Only an Alert-C direction
 * carries an axis, so only it may be positive or negative. A direction the
 * parser already read from a coded value (`directionRef`) is taken as it is.
 */
export function directionOf(event: RoadEvent): DirectionRef | undefined {
  if (event.directionRef !== undefined) return event.directionRef;
  return directionFromText(event.direction, event.externalRefs?.tmc !== undefined);
}

/**
 * A free-text direction as a DirectionRef; `alertC` says the record is placed
 * by TMC location codes, whose direction has an axis.
 */
export function directionFromText(
  value: string | undefined,
  alertC: boolean,
): DirectionRef | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (alertC && (lower === "positive" || lower === "negative" || lower === "both")) {
    return { value: lower, basis: "alert_c" };
  }
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const bearingDeg = Number(raw) % 360;
    return { value: "unknown", basis: "bearing", bearingDeg };
  }
  const compass = entryOf(COMPASS, lower);
  if (compass) return { value: "unknown", basis: "compass", compass, text: raw };
  const loop = entryOf(LOOPS, lower);
  if (loop) return { value: "unknown", basis: "text", loop, text: raw };
  return { value: BOTH.has(lower) ? "both" : "unknown", basis: "text", text: raw };
}

function extentOf(geometry: Geometry | null): string {
  // No geometry yet: only an OpenLR or TMC line reference places the event.
  if (geometry === null) return "linear";
  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
      return "point";
    case "LineString":
    case "MultiLineString":
      return "linear";
    case "Polygon":
    case "MultiPolygon":
      return "area";
    default:
      return geometry.geometries.some((g) => g.type.includes("Polygon"))
        ? "area"
        : geometry.geometries.some((g) => g.type.includes("LineString"))
          ? "linear"
          : "point";
  }
}

function roadRefOf(road: RoadRef): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  const trimmed = road.name?.trim();
  const name =
    road.names ?? (trimmed ? [{ lang: road.nameLang ?? UNDETERMINED, text: trimmed }] : []);
  if (name.length > 0) out["name"] = name;
  if (road.ref) out["ref"] = road.ref;
  const cls = entryOf(ROAD_CLASSES, road.roadClass?.toLowerCase());
  if (cls) out["class"] = cls;
  if (road.from?.trim()) out["from"] = road.from.trim();
  if (road.to?.trim()) out["to"] = road.to.trim();
  if (road.carriageway) out["carriageway"] = road.carriageway;
  if (road.milepostFrom !== undefined) out["milepostFrom"] = road.milepostFrom;
  if (road.milepostTo !== undefined) out["milepostTo"] = road.milepostTo;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The event's location. The published geometry is kept as is; an event whose
 * geometry an OpenLR reference still has to supply has none yet (the resolve
 * stage fills it). TMC-placed geometry says so in `geometryOrigin`.
 */
export function locationOf(
  event: SnapshotEvent,
  source: SourceDescriptor,
): Record<string, unknown> {
  const geometry = (event.geometry ?? null) as Geometry | null;
  const refs = event.externalRefs;
  const roads = (event.roads ?? []).map(roadRefOf).filter((r) => r !== undefined);
  const direction = directionOf(event as RoadEvent);
  const tmc = refs?.tmc;
  return {
    geometry,
    extent: extentOf(geometry),
    geometryOrigin: geometry === null ? "none" : event.locationTable ? "tmc_table" : "source",
    fuzziness: event.fuzziness ?? "exact",
    ...(roads.length > 0 ? { roads } : {}),
    ...(event.linear ? { linear: event.linear } : {}),
    ...(direction ? { direction } : {}),
    ...(tmc
      ? {
          tmc: {
            country: tmc.country,
            // A table number some publishers write with its edition ("6.13", NDW)
            // is table 6; the edition is kept as the version.
            table: Math.trunc(tmc.table),
            ...(tmc.version
              ? { version: tmc.version }
              : Number.isInteger(tmc.table)
                ? {}
                : { version: String(tmc.table) }),
            code: tmc.code,
            ...(tmc.secondary !== undefined ? { secondary: tmc.secondary } : {}),
            ...(tmc.direction === 0 || tmc.direction === 1 ? { direction: tmc.direction } : {}),
            ...(tmc.affectedDirection !== undefined
              ? { affectedDirection: tmc.affectedDirection }
              : {}),
            ...(tmc.extent !== undefined ? { extent: tmc.extent } : {}),
            ...(tmc.method !== undefined ? { method: tmc.method } : {}),
            ...(tmc.primaryOffsetM !== undefined ? { primaryOffsetM: tmc.primaryOffsetM } : {}),
            ...(tmc.secondaryOffsetM !== undefined
              ? { secondaryOffsetM: tmc.secondaryOffsetM }
              : {}),
          },
        }
      : {}),
    ...(refs?.openlr ? { openlr: refs.openlr } : {}),
    ...(refs?.external ? { external: [refs.external] } : {}),
    ...(source.country !== undefined ? { admin: { country: source.country } } : {}),
    ...(event.regions && event.regions.length > 0
      ? { areaDescription: text(event.regions.join(", ")) }
      : {}),
    ...(event.locationTable ? { locationTable: event.locationTable } : {}),
  };
}
