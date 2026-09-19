import { z } from "zod";
import { isKnownTimeZone } from "./wall-clock.js";

export const ICAL_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const IsoDuration = z
  .string()
  .regex(/^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/);
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LocalTime = z.string().min(1);

/**
 * A recurring validity rule, shaped after schema.org `Schedule`
 * (https://schema.org/Schedule). The local wall-clock fields (`startTime`,
 * `startDate`/`endDate`, …) are interpreted in `scheduleTimezone` (an IANA name),
 * so the rule is unambiguous and DST-correct without materialising occurrences.
 * `duration` is the authoritative occurrence length (overnight-safe, e.g.
 * "PT9H" for 20:00–05:00); `endTime` is an optional human-readable convenience.
 * `startTime` stays a loose string: feeds publish variants (`20:00:00+02:00`,
 * `8:00`) that the evaluator normalises, and an unparseable one never
 * suppresses (see `scheduleOccursAt`).
 */
export const Schedule = z.strictObject({
  /** ISO 8601 duration between occurrences: "P1D" daily, "P1W" weekly. */
  repeatFrequency: IsoDuration.optional(),
  /** Bound the recurrence by a count of occurrences instead of `endDate`. */
  repeatCount: z.number().int().positive().optional(),
  /** Local ISO date of the first occurrence (recurrence lower bound). */
  startDate: LocalDate.optional(),
  /** Local ISO date of the last occurrence's start (recurrence upper bound). */
  endDate: LocalDate.optional(),
  /** Local time-of-day each occurrence starts ("HH:MM" or "HH:MM:SS"). */
  startTime: LocalTime.optional(),
  /** Optional local end time-of-day (human-readable; `duration` is authoritative). */
  endTime: LocalTime.optional(),
  /** ISO 8601 duration of each occurrence, e.g. "PT9H"; overnight-safe. */
  duration: IsoDuration.optional(),
  /** Days of week as two-letter iCal codes. */
  byDay: z.array(z.enum(ICAL_DAYS)).min(1).optional(),
  /** Months of the year (1-12) the recurrence applies to. */
  byMonth: z.array(z.number().int().min(1).max(12)).min(1).optional(),
  /** Days of the month (1-31). */
  byMonthDay: z.array(z.number().int().min(1).max(31)).min(1).optional(),
  /** Local ISO dates excluded from the recurrence. */
  exceptDate: z.array(LocalDate).min(1).optional(),
  /** IANA timezone the local fields above are expressed in (e.g. "Europe/Berlin"). */
  scheduleTimezone: z.string().refine(isKnownTimeZone, { message: "unknown IANA time zone" }),
});

/**
 * The schema validates `byDay` against the iCal codes; the TS type keeps it a
 * `string[]`, as parsers build it from source tokens before validation.
 */
export type Schedule = Omit<z.output<typeof Schedule>, "byDay"> & { byDay?: string[] };
