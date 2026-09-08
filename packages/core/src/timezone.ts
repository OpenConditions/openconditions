import type { Geometry } from "geojson";
import tzLookup from "tz-lookup";

/**
 * IANA timezone name for a coordinate (e.g. `"Europe/Berlin"`), or `null` when
 * the lookup fails (coordinate outside the dataset, e.g. open ocean). Thin
 * wrapper over `tz-lookup`, which takes `(lat, lng)`.
 */
export function timeZoneAt(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    return tzLookup(lat, lng);
  } catch {
    return null;
  }
}

/** First `[lng, lat]` coordinate found in any GeoJSON geometry, or `null`. */
function firstCoordinate(geometry: Geometry): [number, number] | null {
  const g = geometry as {
    type?: string;
    coordinates?: unknown;
    geometries?: Geometry[];
  };
  if (g.type === "GeometryCollection") {
    for (const sub of g.geometries ?? []) {
      const c = firstCoordinate(sub);
      if (c) return c;
    }
    return null;
  }
  let node: unknown = g.coordinates;
  while (Array.isArray(node) && Array.isArray(node[0])) node = node[0];
  if (Array.isArray(node) && typeof node[0] === "number" && typeof node[1] === "number") {
    return [node[0], node[1]];
  }
  return null;
}

/**
 * IANA timezone for a geometry's representative point, or `null`. Used to stamp
 * a `Schedule.scheduleTimezone` at parse time so the recurrence's local times
 * are interpretable by any consumer without re-deriving the zone. A road
 * segment lies within one zone, so the first coordinate is sufficient.
 */
export function scheduleTimezoneForGeometry(geometry: Geometry | null | undefined): string | null {
  if (!geometry) return null;
  const coord = firstCoordinate(geometry);
  if (!coord) return null;
  const [lng, lat] = coord;
  return timeZoneAt(lat, lng);
}

const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsAt(timeZone: string, epochMs: number): WallClockParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  return {
    year: map.year!,
    month: map.month!,
    day: map.day!,
    hour: map.hour! % 24,
    minute: map.minute!,
    second: map.second!,
  };
}

/** `YYYY-MM-DD` of the instant `at` as seen on a wall clock in `timeZone`. */
export function localDateInZone(at: Date, timeZone: string): string {
  const p = partsAt(timeZone, at.getTime());
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Converts a local wall-clock string (`YYYY-MM-DDTHH:mm[:ss]`) in `timeZone`
 * to an absolute instant. Two-pass offset correction handles DST; returns
 * `null` for an unparseable string, an invalid calendar date, or an unknown
 * zone. A non-existent local time (spring-forward gap) resolves to the
 * instant after the gap rather than failing.
 */
export function zonedWallClockToInstant(timeZone: string, wallClock: string): Date | null {
  const m = wallClock.match(WALL_CLOCK_PATTERN);
  if (!m) return null;
  const want = {
    year: +m[1]!,
    month: +m[2]!,
    day: +m[3]!,
    hour: +m[4]!,
    minute: +m[5]!,
    second: +(m[6] ?? 0),
  };
  const naive = Date.UTC(want.year, want.month - 1, want.day, want.hour, want.minute, want.second);
  const d = new Date(naive);
  if (
    d.getUTCFullYear() !== want.year ||
    d.getUTCMonth() + 1 !== want.month ||
    d.getUTCDate() !== want.day
  ) {
    return null;
  }
  let guess = naive;
  try {
    for (let i = 0; i < 2; i++) {
      const p = partsAt(timeZone, guess);
      const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      guess += naive - asUtc;
    }
  } catch {
    return null;
  }
  return new Date(guess);
}
