import type { DirectionRef, Geometry, Text } from "@openconditions/model";
import type { RoadEvent, RoadRef } from "../model.js";
import type { SnapshotEvent } from "../snapshot.js";
import type { SourceDescriptor } from "../types.js";

/** Language of source text whose language the parser does not know (BCP 47 "undetermined"). */
export const UNDETERMINED = "und";

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

const BOTH = new Set([
  "both",
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
 * TMC-located event basis `alert_c`; anything else stays verbatim text with
 * value `unknown` (or `both` when it says so). Only an Alert-C direction
 * carries an axis, so only it may be positive or negative.
 */
export function directionOf(event: RoadEvent): DirectionRef | undefined {
  const raw = event.direction?.trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (
    event.externalRefs?.tmc &&
    (lower === "positive" || lower === "negative" || lower === "both")
  ) {
    return { value: lower, basis: "alert_c" };
  }
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const bearingDeg = Number(raw) % 360;
    return { value: "unknown", basis: "bearing", bearingDeg };
  }
  const compass = COMPASS[lower];
  if (compass) return { value: "unknown", basis: "compass", compass, text: raw };
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
  const name = text(road.name);
  if (name) out["name"] = name;
  if (road.ref) out["ref"] = road.ref;
  const cls = road.roadClass ? ROAD_CLASSES[road.roadClass.toLowerCase()] : undefined;
  if (cls) out["class"] = cls;
  if (road.from?.trim()) out["from"] = road.from.trim();
  if (road.to?.trim()) out["to"] = road.to.trim();
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
    ...(direction ? { direction } : {}),
    ...(tmc
      ? {
          tmc: {
            country: tmc.country,
            // A table number some publishers write with its edition ("6.13", NDW)
            // is table 6; the edition is kept as the version.
            table: Math.trunc(tmc.table),
            ...(Number.isInteger(tmc.table) ? {} : { version: String(tmc.table) }),
            code: tmc.code,
            ...(tmc.direction === 0 || tmc.direction === 1 ? { direction: tmc.direction } : {}),
            ...(tmc.extent !== undefined ? { extent: tmc.extent } : {}),
          },
        }
      : {}),
    ...(refs?.openlr ? { openlr: refs.openlr } : {}),
    ...(refs?.external ? { external: [refs.external] } : {}),
    admin: { country: source.country },
    ...(event.regions && event.regions.length > 0
      ? { areaDescription: text(event.regions.join(", ")) }
      : {}),
    ...(event.locationTable ? { locationTable: event.locationTable } : {}),
  };
}
