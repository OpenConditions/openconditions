export const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const formats = new Map<string, Intl.DateTimeFormat>();

function formatIn(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(zone, format);
  }
  return format;
}

/** The wall-clock date (`YYYY-MM-DD`) and time (`HH:MM:SS`) `zone` shows at `at`. */
export function wallClock(at: Date, zone: string): { date: string; time: string } {
  const parts = formatIn(zone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

/** How far `zone` is ahead of UTC at `at`, in milliseconds. */
function offsetMs(zone: string, at: number): number {
  const second = Math.floor(at / 1000) * 1000;
  const { date, time } = wallClock(new Date(second), zone);
  return Date.parse(`${date}T${time}Z`) - second;
}

/**
 * The instant a wall-clock `date` and `time` (`HH:MM` or `HH:MM:SS`) name in
 * `zone`. A time in the hour a zone repeats reads as the first of the two.
 */
export function zonedInstant(date: string, time: string, zone: string): Date {
  const wall = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  const guess = wall - offsetMs(zone, wall);
  return new Date(wall - offsetMs(zone, guess));
}

/** The day before `date` (`YYYY-MM-DD`). */
export function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** `h`, `mm` and `am`/`pm` as a 24-hour `HH:MM`. */
export function clock(hour: number, minute: number, half: "am" | "pm"): string {
  const h = (hour % 12) + (half === "pm" ? 12 : 0);
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
