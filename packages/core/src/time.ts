import { zonedWallClockToInstant } from "@openconditions/model";

/**
 * A date, with a time of day or without, written without an offset: `-` or
 * `/` between its parts, `T` or a space before the time.
 */
const WALL_CLOCK = /^(\d{4})([-/])(\d{2})\2(\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?)?$/;

/**
 * A date written day first with dots, as German publishers write it
 * (`04.05.2026`, `04.05.2026 10:00`, `10.08.2026 16 Uhr`), with or without a
 * time of day. A dotted date with the year last is day-month-year wherever it
 * is written; `Date.parse` would read it month first in the host's zone.
 */
const DOTTED_DATE =
  /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,?\s+(\d{1,2})(?::(\d{2})(?::(\d{2}))?(?:\s*Uhr)?|\s*Uhr))?$/i;

/**
 * Normalise a timestamp from the many shapes feeds emit — ISO 8601 strings,
 * epoch seconds or milliseconds (as a number or a numeric string), or a `Date` —
 * into a UTC ISO 8601 string. Returns `undefined` for null, empty, or
 * unparseable input, so a single malformed value can never reach a `timestamptz`
 * column and abort a whole batch insert.
 *
 * A date and time written without an offset is wall-clock time in `timeZone`,
 * the IANA zone its publisher writes in, and a date alone its midnight (a
 * validity's end names the last day instead: see {@link validityBound});
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
    const dotted = DOTTED_DATE.exec(s);
    if (dotted !== null) {
      const [, day = "", month = "", year = "", hour = "0", minute = "00", second = "00"] = dotted;
      if (!isCalendarDate(Number(year), Number(month), Number(day))) return undefined;
      if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
      const pad = (v: string) => v.padStart(2, "0");
      const wallClock = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:${second}`;
      return zonedWallClockToInstant(timeZone ?? "UTC", wallClock)?.toISOString();
    }
    // Date.parse rolls a day the month does not have over into the next
    // month (30 February is 2 March); a changed date is worse than none.
    const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (date !== null && !isCalendarDate(Number(date[1]), Number(date[2]), Number(date[3]))) {
      return undefined;
    }
    if (date === null && !isEnglishDate(s)) return undefined;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }

  return undefined;
}

/** A word an English date may contain: a month, a weekday, AM/PM or a zone. */
const DATE_WORD =
  /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|gmt|utc|ut|z|[ecmp][sd]t)$/i;
const MONTH_WORD = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)/i;

/**
 * Whether a string is a date written with an English month name, as RFC 2822
 * and HTTP dates are (`Thu, 29 Oct 2026 10:00:00 GMT`, `October 29, 2026`):
 * a month, a day and a four-digit year, and no word that is not part of a
 * date. `Date.parse` reads any text it can scrape a number from, so free
 * text in a date field (`Ende Nov. 2026`, `KW 46`) would otherwise become a
 * confident wrong date rather than none.
 */
function isEnglishDate(s: string): boolean {
  const words = s.match(/\p{L}+/gu) ?? [];
  if (!words.every((w) => DATE_WORD.test(w))) return false;
  if (!words.some((w) => MONTH_WORD.test(w))) return false;
  return /\b\d{4}\b/.test(s) && /\b\d{1,2}\b/.test(s.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " "));
}

/** Whether a year, month and day name a day of the proleptic Gregorian calendar. */
function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const at = new Date(Date.UTC(2000, month - 1, day));
  at.setUTCFullYear(year);
  return at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

function fromEpoch(n: number): string | undefined {
  if (!Number.isFinite(n)) return undefined;
  const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** How a source writes its times, beyond the zone of its local ones. */
export interface SourceTimes {
  /** The IANA zone the source writes local times and days in; UTC without one. */
  timeZone?: string;
  /**
   * The source writes its local times with a UTC designator (`Z`, `+00:00`)
   * they do not have: `09:00:00Z` for 09:00 in `timeZone`. A Mobilitätsatlas
   * closure "von 09:00 Uhr - 13:00 Uhr" is published `09:00:00Z`–`13:00:00Z`.
   */
  localTimesMarkedUtc?: boolean;
  /**
   * The source writes days as midnight instants: `2026-10-30T00:00:00`, or an
   * epoch at midnight UTC (an ArcGIS date field). Such a value names a day.
   * A real midnight looks the same, so only a source that writes days so
   * declares it.
   */
  daysAtMidnight?: boolean;
}

const UTC_DESIGNATOR = /(?:Z|[+-]00:?00)$/i;

/** A value as its source means it: a UTC designator it marks local times with dropped. */
function asWritten(value: unknown, times: SourceTimes): unknown {
  return times.localTimesMarkedUtc && typeof value === "string"
    ? value.trim().replace(UTC_DESIGNATOR, "")
    : value;
}

/**
 * {@link toIsoTimestamp} for a value as its source writes it: a time the
 * source marks UTC though it is local (`localTimesMarkedUtc`) is read as the
 * local time it is.
 */
export function sourceTimestamp(value: unknown, times: SourceTimes = {}): string | undefined {
  return toIsoTimestamp(asWritten(value, times), times.timeZone);
}

const DAY_MS = 86_400_000;

/** A date alone, `-` or `/` between its parts, with the zone GeoServer writes on an `xsd:date`. */
const DATE_ALONE = /^(\d{4})([-/])(\d{2})\2(\d{2})Z?$/i;
/** A date alone, day first with dots (`01.11.2026`). */
const DOTTED_DATE_ALONE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
/**
 * A date at midnight: `2026-10-30T00:00:00.000`, `2026/10/30 00:00Z`,
 * `30.10.2026 00:00 Uhr`. With an offset it is still the date written: a
 * publisher writing a day at its own midnight names that day.
 */
const DATE_AT_MIDNIGHT =
  /^(?:(\d{4})([-/])(\d{2})\2(\d{2})[T ]|(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s+)00:00(?::00(?:\.0+)?)?(?:\s*Uhr)?(?:Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * The day a value names, `YYYY-MM-DD`: a date with no time of day, or, for a
 * source writing days at midnight, a date at midnight or an epoch at midnight
 * UTC. Undefined for an instant, or a day the month does not have.
 */
export function calendarDayOf(value: unknown, times: SourceTimes = {}): string | undefined {
  let ymd: [number, number, number] | undefined;
  if (typeof value === "number" || (typeof value === "string" && /^-?\d+$/.test(value.trim()))) {
    if (!times.daysAtMidnight) return undefined;
    const read = toIsoTimestamp(value);
    const ms = read === undefined ? Number.NaN : Date.parse(read);
    if (!Number.isFinite(ms) || ms % DAY_MS !== 0) return undefined;
    const at = new Date(ms);
    ymd = [at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate()];
  } else if (typeof value === "string") {
    const s = value.trim();
    const iso = DATE_ALONE.exec(s);
    const dotted = DOTTED_DATE_ALONE.exec(s);
    const midnight = times.daysAtMidnight ? DATE_AT_MIDNIGHT.exec(s) : null;
    if (iso) ymd = [Number(iso[1]), Number(iso[3]), Number(iso[4])];
    else if (dotted) ymd = [Number(dotted[3]), Number(dotted[2]), Number(dotted[1])];
    else if (midnight?.[1]) ymd = [Number(midnight[1]), Number(midnight[3]), Number(midnight[4])];
    else if (midnight?.[5]) ymd = [Number(midnight[7]), Number(midnight[6]), Number(midnight[5])];
  }
  // A year a timestamp cannot hold (an epoch far out of range) is no day.
  if (!ymd || ymd[0] < 1 || ymd[0] > 9999 || !isCalendarDate(...ymd)) return undefined;
  const [y, m, d] = ymd;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The day after a `YYYY-MM-DD` day; undefined for no day, or past 9999. */
export function nextDay(day: string): string | undefined {
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return undefined;
  at.setUTCDate(at.getUTCDate() + 1);
  return at.getUTCFullYear() > 9999 ? undefined : at.toISOString().slice(0, 10);
}

/**
 * One bound of a validity as an instant. A value naming a day
 * ({@link calendarDayOf}) is that day: a start begins at its first moment,
 * an end runs to its last, the next midnight in the source's zone. So works
 * "until 1 November" end as 1 November ends, not as it begins. Any other value
 * is the instant {@link sourceTimestamp} reads.
 */
export function validityBound(
  value: unknown,
  bound: "start" | "end",
  times: SourceTimes = {},
): string | undefined {
  const day = calendarDayOf(asWritten(value, times), times);
  if (day === undefined) return sourceTimestamp(value, times);
  const at = bound === "end" ? nextDay(day) : day;
  return at === undefined ? undefined : toIsoTimestamp(at, times.timeZone);
}
