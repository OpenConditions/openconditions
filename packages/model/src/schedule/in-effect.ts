import type { Validity } from "../kernel/validity.js";
import type { Schedule } from "./schedule.js";
import { localDateInZone, zonedWallClockToInstant } from "./wall-clock.js";

const ICAL_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

function parseHhMm(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** ISO-8601 duration (PnDTnHnMnS subset) in milliseconds. */
export function isoDurationToMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return (
    (Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) *
    1_000
  );
}

function occurrenceDurationMs(s: Schedule): number {
  const explicit = isoDurationToMs(s.duration);
  if (explicit != null) return explicit;
  const a = parseHhMm(s.startTime);
  const b = parseHhMm(s.endTime);
  if (a != null && b != null) {
    let mins = b - a;
    if (mins <= 0) mins += 24 * 60;
    return mins * 60_000;
  }
  return 24 * 3_600 * 1_000;
}

/**
 * How many local days before `at` an occurrence still covering `at` may have
 * started: one for a window within a day or overnight, more for a longer one
 * (a one-off DATEX period). Bounded at a year.
 */
function lookbackDays(s: Schedule): number {
  return Math.min(366, Math.max(1, Math.ceil(occurrenceDurationMs(s) / 86_400_000)));
}

/**
 * A schedule's `startTime` as the `HH:mm:ss` wall clock it denotes, or `null`
 * when it is not a time at all. Feeds publish variants a strict wall-clock
 * parser rejects: a trailing `Z`, a UTC offset (DATEX `startTimeOfPeriod`), or
 * a 1-digit hour. A zone suffix is dropped rather than applied — a recurrence's
 * time of day is by definition local to `scheduleTimezone`, so `20:00:00+02:00`
 * on a `Europe/Berlin` schedule means 20:00 in Berlin, on both sides of a DST
 * boundary.
 */
function normalizeStartTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return null;
  const hour = Number(m[1]);
  if (hour > 23 || Number(m[2]) > 59) return null;
  return `${String(hour).padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
}

function addDaysLocal(localDate: string, delta: number): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function occurrenceStartsOn(s: Schedule, localDate: string): boolean {
  if (s.startDate && localDate < s.startDate.slice(0, 10)) return false;
  if (s.endDate && localDate > s.endDate.slice(0, 10)) return false;
  if (s.exceptDate?.some((x) => x.slice(0, 10) === localDate)) return false;
  if (s.byDay && s.byDay.length > 0) {
    const dow = new Date(`${localDate}T00:00:00Z`).getUTCDay();
    if (!s.byDay.includes(ICAL_DAY[dow]!)) return false;
  }
  if (s.byMonth && s.byMonth.length > 0 && !s.byMonth.includes(Number(localDate.slice(5, 7)))) {
    return false;
  }
  if (
    s.byMonthDay &&
    s.byMonthDay.length > 0 &&
    !s.byMonthDay.includes(Number(localDate.slice(8, 10)))
  ) {
    return false;
  }
  return true;
}

/**
 * Whether `at` falls inside an occurrence of a schema.org-shaped Schedule,
 * evaluated in the schedule's own `scheduleTimezone`. Checks the occurrences
 * starting on `at`'s local date and on each day before it that an occurrence
 * as long as the schedule's could still cover (the day before, for a window
 * that crosses midnight). `unevaluable` = the zone is missing or unknown,
 * or the start time cannot be turned into an instant. A day the recurrence
 * rules genuinely exclude is `out`, not `unevaluable`.
 */
export function scheduleStateAt(s: Schedule, at: Date): "in" | "out" | "unevaluable" {
  const tz = s.scheduleTimezone;
  if (!tz) return "unevaluable";
  const startTime = normalizeStartTime(s.startTime ?? "00:00");
  if (!startTime) return "unevaluable";
  const durMs = occurrenceDurationMs(s);
  let today: string;
  try {
    today = localDateInZone(at, tz);
  } catch {
    return "unevaluable";
  }
  let unevaluable = false;
  for (let delta = 0; delta >= -lookbackDays(s); delta--) {
    const day = addDaysLocal(today, delta);
    if (!occurrenceStartsOn(s, day)) continue;
    const start = zonedWallClockToInstant(tz, `${day}T${startTime}`);
    if (!start) {
      unevaluable = true;
      continue;
    }
    const t0 = start.getTime();
    if (at.getTime() >= t0 && at.getTime() < t0 + durMs) return "in";
  }
  return unevaluable ? "unevaluable" : "out";
}

/**
 * Whether a schedule is in effect at `at`. An unevaluable schedule is treated
 * as in effect: never suppress on missing data.
 */
export function scheduleOccursAt(s: Schedule, at: Date): boolean {
  return scheduleStateAt(s, at) !== "out";
}

/**
 * Whether an observation is in effect at `at`. The coarse `validFrom`/`validTo`
 * span and the `schedule` INTERSECT: `at` must fall inside the span and, when a
 * schedule is present, inside one of its occurrences. A missing or unparseable
 * bound leaves that side of the span unbounded, so an observation with neither
 * span nor schedule is always in effect.
 */
export function isInEffectAt(
  obs: { validFrom?: string | null; validTo?: string | null; schedule?: Schedule[] },
  at: Date,
): boolean {
  const t = at.getTime();
  if (Number.isNaN(t)) return true;
  if (obs.validFrom) {
    const from = Date.parse(obs.validFrom);
    if (!Number.isNaN(from) && t < from) return false;
  }
  if (obs.validTo) {
    const to = Date.parse(obs.validTo);
    if (!Number.isNaN(to) && t >= to) return false;
  }
  if (obs.schedule && obs.schedule.length > 0) {
    return obs.schedule.some((s) => scheduleOccursAt(s, at));
  }
  return true;
}

/**
 * Whether a kernel `Validity` is in effect at `at`: inside `[start, end)`, inside
 * one of `periods` when there are any, and not inside an `exceptions`
 * occurrence. `status` is never read. An exception only suppresses when it
 * definitely matches; an unevaluable exception is ignored, the same "never
 * suppress on missing data" rule `scheduleOccursAt` applies to periods.
 */
export function isValidityInEffectAt(validity: Validity, at: Date): boolean {
  const inWindow = isInEffectAt(
    { validFrom: validity.start, validTo: validity.end, schedule: validity.periods },
    at,
  );
  if (!inWindow) return false;
  return !(validity.exceptions ?? []).some((s) => scheduleStateAt(s, at) === "in");
}

/**
 * Finds the next instant at which the aggregate schedule changes state. The
 * search is bounded to one leap-year horizon; a schedule with no evaluable
 * transition in that horizon returns null and therefore cannot manufacture a
 * routing lease.
 */
export function nextScheduleTransition(schedules: Schedule[], at: Date): string | null {
  if (schedules.length === 0 || Number.isNaN(at.getTime())) return null;
  const candidates = new Set<number>();
  for (const schedule of schedules) {
    const startTime = normalizeStartTime(schedule.startTime ?? "00:00");
    if (!startTime || !schedule.scheduleTimezone) continue;
    let localDate: string;
    try {
      localDate = localDateInZone(at, schedule.scheduleTimezone);
    } catch {
      continue;
    }
    for (let delta = -lookbackDays(schedule); delta <= 366; delta++) {
      const day = addDaysLocal(localDate, delta);
      if (!occurrenceStartsOn(schedule, day)) continue;
      const start = zonedWallClockToInstant(schedule.scheduleTimezone, `${day}T${startTime}`);
      if (!start) continue;
      candidates.add(start.getTime());
      candidates.add(start.getTime() + occurrenceDurationMs(schedule));
    }
  }
  for (const candidate of [...candidates].filter((v) => v > at.getTime()).sort((a, b) => a - b)) {
    const before = schedules.some((schedule) =>
      scheduleOccursAt(schedule, new Date(candidate - 1)),
    );
    const after = schedules.some((schedule) => scheduleOccursAt(schedule, new Date(candidate)));
    if (before !== after) return new Date(candidate).toISOString();
  }
  return null;
}
