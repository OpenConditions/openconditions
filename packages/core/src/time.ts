import { zonedWallClockToInstant } from "@openconditions/model";

/**
 * A date, with a time of day or without, written without an offset: `-` or
 * `/` between its parts, `T` or a space before the time.
 */
const WALL_CLOCK = /^(\d{4})([-/])(\d{2})\2(\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?)?$/;

/**
 * Normalise a timestamp from the many shapes feeds emit — ISO 8601 strings,
 * epoch seconds or milliseconds (as a number or a numeric string), or a `Date` —
 * into a UTC ISO 8601 string. Returns `undefined` for null, empty, or
 * unparseable input, so a single malformed value can never reach a `timestamptz`
 * column and abort a whole batch insert.
 *
 * A date and time written without an offset is wall-clock time in `timeZone`,
 * the IANA zone its publisher writes in, and a date alone its midnight;
 * without a zone both are read as UTC, never in the host's zone, so every
 * instance reads a payload alike.
 *
 * Epoch heuristic: an absolute value below 1e11 is treated as seconds (1e11 s ≈
 * year 5138, while current epochs are ~1.7e9), otherwise as milliseconds
 * (1e11 ms ≈ 1973).
 */
export function toIsoTimestamp(value: unknown, timeZone?: string): string | undefined {
  if (value === null || value === undefined) return undefined;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }

  if (typeof value === "number") return fromEpoch(value);

  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return undefined;
    if (/^-?\d+$/.test(s)) return fromEpoch(Number(s));
    const wall = WALL_CLOCK.exec(s);
    if (wall !== null) {
      const [, year, , month, day, time = "00:00", fraction] = wall;
      const at = zonedWallClockToInstant(timeZone ?? "UTC", `${year}-${month}-${day}T${time}`);
      if (at === null) return undefined;
      const ms = fraction === undefined ? 0 : Math.round(Number(`0${fraction}`) * 1000);
      return new Date(at.getTime() + ms).toISOString();
    }
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }

  return undefined;
}

function fromEpoch(n: number): string | undefined {
  if (!Number.isFinite(n)) return undefined;
  const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
