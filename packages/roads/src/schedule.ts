import type { Schedule } from "@openconditions/core";

/**
 * A schema.org-shaped `Schedule` minus its zone — the local-only shape a parser
 * builds before the observation's timezone is known. `withTimezone` completes
 * it into a published {@link Schedule}.
 */
export type LocalSchedule = Omit<Schedule, "scheduleTimezone">;

const ICAL_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** JS weekday index (0=Sun..6=Sat) → iCal two-letter code. */
export function jsDayToICal(day: number): string | undefined {
  return ICAL_DAY[((day % 7) + 7) % 7];
}

/** ISO-8601 weekday (1=Mon..7=Sun) → iCal two-letter code. */
export function isoDayToICal(day: number): string | undefined {
  return jsDayToICal(day % 7); // ISO 7 (Sun) → JS 0; 1..6 unchanged
}

function parseHhMm(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * ISO-8601 duration between two local times-of-day, overnight-aware: a window
 * whose end is at/before its start wraps past midnight (e.g. 20:00→05:00 ⇒
 * "PT9H"). Returns undefined when either time is unparseable.
 */
export function durationBetween(startTime?: string, endTime?: string): string | undefined {
  const s = parseHhMm(startTime);
  const e = parseHhMm(endTime);
  if (s == null || e == null) return undefined;
  let mins = e - s;
  if (mins <= 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}`;
}

export interface LocalScheduleInput {
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  /** iCal day codes (SU..SA); when present, the recurrence is restricted to these days. */
  byDay?: string[];
}

/**
 * Build a local (zone-less) schema.org-shaped Schedule from local window parts.
 * `repeatFrequency` is weekly when day-of-week restricted, else daily; the
 * occurrence length is captured in `duration` (overnight-safe).
 */
export function buildLocalSchedule(input: LocalScheduleInput): LocalSchedule {
  const hasDays = !!input.byDay && input.byDay.length > 0;
  const s: LocalSchedule = { repeatFrequency: hasDays ? "P1W" : "P1D" };
  if (input.startDate) s.startDate = input.startDate;
  if (input.endDate) s.endDate = input.endDate;
  if (input.startTime) s.startTime = input.startTime;
  if (input.endTime) s.endTime = input.endTime;
  const duration = durationBetween(input.startTime, input.endTime);
  if (duration) s.duration = duration;
  if (hasDays) s.byDay = input.byDay;
  return s;
}

/**
 * Stamp the IANA zone onto local schedules to produce the published
 * `Schedule[]`. Returns undefined when there are no schedules or the zone is
 * unresolved — a zone-less schedule is ambiguous, so the consumer should fall
 * back to the absolute `validFrom`/`validTo` span instead.
 */
export function withTimezone(
  schedules: LocalSchedule[] | undefined,
  timeZone: string | null
): Schedule[] | undefined {
  if (!schedules || schedules.length === 0 || !timeZone) return undefined;
  return schedules.map((s) => ({ ...s, scheduleTimezone: timeZone }));
}
