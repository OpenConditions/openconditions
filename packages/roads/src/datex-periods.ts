import {
  localDateInZone,
  localTimeInZone,
  type Schedule,
  zonedWallClockToInstant,
} from "@openconditions/model";
import type { LocalSchedule } from "./schedule.js";

/**
 * DATEX `validPeriod` and `exceptionPeriod` bounds are instants; a kernel
 * schedule's bounds are local dates, of the first and last occurrence. A
 * period of instants alone keeps its instants as one window (or, open-ended,
 * as days overlapping from its start); a recurring period keeps the first and
 * last occurrence its instants admit. A bound that falls inside an occurrence
 * cuts it short, which no local date says: such a period is reported as
 * inexact rather than widened to the whole occurrence. A bound at or beyond
 * the record's overall window changes nothing the overall window does not
 * already bound, so it is not.
 */

const ICAL_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const DAY_MS = 86_400_000;

/** A local date `n` days after `date`. */
function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** An ISO 8601 duration of days, hours, minutes and seconds. */
function isoDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const [d, h, m, s] = [
    Math.floor(total / 86_400),
    Math.floor((total % 86_400) / 3_600),
    Math.floor((total % 3_600) / 60),
    total % 60,
  ];
  const time = `${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s ? `${s}S` : ""}`;
  return `P${d ? `${d}D` : ""}${time ? `T${time}` : ""}`;
}

/** A DATEX date-time as epoch milliseconds; one without a zone designator is local. */
function instantOf(value: string | undefined, timeZone: string): number | undefined | null {
  if (value === undefined) return undefined;
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return zonedWallClockToInstant(timeZone, value)?.getTime() ?? null;
}

/** The instant a local date and time of day names, in epoch milliseconds. */
function at(timeZone: string, date: string, time: string): number | null {
  return zonedWallClockToInstant(timeZone, `${date}T${time}`)?.getTime() ?? null;
}

/**
 * One recurring local schedule as its occurrences: when the one on a local
 * date starts and ends, and whether there is one that day.
 */
function occurrences(s: LocalSchedule, timeZone: string) {
  const from = s.startTime ?? "00:00:00";
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const overnight = s.endTime !== undefined && minutes(s.endTime) <= minutes(from);
  return {
    start: (date: string) => at(timeZone, date, from),
    end: (date: string) =>
      s.startTime === undefined || s.endTime === undefined
        ? at(timeZone, addDays(date, 1), "00:00:00")
        : at(timeZone, overnight ? addDays(date, 1) : date, s.endTime),
    on: (date: string) => {
      const day = new Date(`${date}T00:00:00Z`);
      return (
        (s.byDay === undefined || s.byDay.includes(ICAL_DAYS[day.getUTCDay()] ?? "")) &&
        (s.byMonth === undefined || s.byMonth.includes(day.getUTCMonth() + 1))
      );
    },
  };
}

/** Whether an occurrence started before `t` and has not ended at it. */
function straddles(o: ReturnType<typeof occurrences>, t: number, timeZone: string): boolean {
  const today = localDateInZone(new Date(t), timeZone);
  for (const date of [addDays(today, -2), addDays(today, -1), today]) {
    const start = o.start(date);
    const end = o.end(date);
    if (o.on(date) && start !== null && end !== null && start < t && t < end) return true;
  }
  return false;
}

/** One DATEX period as a kernel schedule, and whether it says exactly what the period does. */
function kernelPeriod(
  s: LocalSchedule,
  timeZone: string,
  overall: { start?: number; end?: number },
): { schedule?: Schedule; exact: boolean } {
  const start = instantOf(s.startDate, timeZone);
  const end = instantOf(s.endDate, timeZone);
  if (start === null || end === null) return { exact: false };
  const recurring = s.startTime !== undefined || s.byDay !== undefined || s.byMonth !== undefined;
  if (!recurring) {
    const from = start ?? overall.start;
    const to = end ?? overall.end;
    if (from === undefined || (to !== undefined && to <= from)) return { exact: false };
    const day = localDateInZone(new Date(from), timeZone);
    const time = localTimeInZone(new Date(from), timeZone);
    return to === undefined
      ? {
          // Every day from the start, each day reaching past the next one's
          // start whatever its length on a clock change: the time from then on.
          schedule: {
            repeatFrequency: "P1D",
            startDate: day,
            startTime: time,
            duration: "PT25H",
            scheduleTimezone: timeZone,
          },
          exact: true,
        }
      : {
          schedule: {
            startDate: day,
            endDate: day,
            startTime: time,
            duration: isoDuration(to - from),
            scheduleTimezone: timeZone,
          },
          exact: true,
        };
  }
  const o = occurrences(s, timeZone);
  const { startDate: _, endDate: __, ...rest } = s;
  const schedule: Schedule = { ...rest, scheduleTimezone: timeZone };
  let exact = true;
  if (start !== undefined) {
    const day = localDateInZone(new Date(start), timeZone);
    const inside = overall.start === undefined || start > overall.start;
    if (inside && straddles(o, start, timeZone)) exact = false;
    const first = o.start(day);
    schedule.startDate = first !== null && first < start ? addDays(day, 1) : day;
  }
  if (end !== undefined) {
    const day = localDateInZone(new Date(end), timeZone);
    const inside = overall.end === undefined || end < overall.end;
    if (inside && straddles(o, end, timeZone)) exact = false;
    const last = o.start(day);
    schedule.endDate = last !== null && last < end ? day : addDays(day, -1);
  }
  return { schedule, exact };
}

/**
 * A record's DATEX periods as kernel schedules in the zone of its place,
 * bounded by its overall window, with whether any of them is inexact.
 */
export function zonedPeriods(
  schedules: LocalSchedule[] | undefined,
  timeZone: string | null,
  overall: { start?: string | undefined; end?: string | undefined },
): { schedules?: Schedule[]; inexact: boolean } {
  if (!schedules || schedules.length === 0 || !timeZone) return { inexact: false };
  const bounds = {
    start: instantOf(overall.start, timeZone) ?? undefined,
    end: instantOf(overall.end, timeZone) ?? undefined,
  };
  const read = schedules.map((s) => kernelPeriod(s, timeZone, bounds));
  const out = read.flatMap((r) => (r.schedule ? [r.schedule] : []));
  return {
    ...(out.length > 0 ? { schedules: out } : {}),
    inexact: read.some((r) => !r.exact),
  };
}
