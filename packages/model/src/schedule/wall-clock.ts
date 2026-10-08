const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * One formatter per zone: building one costs native memory that a feed of
 * tens of thousands of local timestamps would otherwise multiply.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function partsAt(timeZone: string, epochMs: number): WallClockParts {
  let fmt = FORMATTERS.get(timeZone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(timeZone, fmt);
  }
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

/** Whether `timeZone` is an IANA zone this runtime can evaluate. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` of the instant `at` as seen on a wall clock in `timeZone`. */
export function localDateInZone(at: Date, timeZone: string): string {
  const p = partsAt(timeZone, at.getTime());
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** `HH:mm:ss` of the instant `at` as seen on a wall clock in `timeZone`. */
export function localTimeInZone(at: Date, timeZone: string): string {
  const p = partsAt(timeZone, at.getTime());
  return [p.hour, p.minute, p.second].map((n) => String(n).padStart(2, "0")).join(":");
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
