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
