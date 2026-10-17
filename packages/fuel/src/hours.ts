/** One opening interval of a day, as `HH:MM` local times. */
export interface Interval {
  opens: string;
  closes: string;
}

/** The OSM weekdays, Monday first, in the order a week is given. */
const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

const TIME = /^(\d{1,2})[:.](\d{2})$/;

/**
 * A source time (`7:00`, `07.00`, `24:00`) as `HH:MM`; undefined when it is
 * not a time of day.
 */
export function clockTime(value: string): string | undefined {
  const m = value.trim().match(TIME);
  if (!m) return undefined;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes > 0)) return undefined;
  return `${String(hours).padStart(2, "0")}:${m[2]}`;
}

/**
 * An interval from two source times; undefined when either is unreadable or
 * both are the same, which says neither closed nor open all day. A closing
 * time of midnight after an opening time is written as the end of the day.
 */
export function interval(opens: string, closes: string): Interval | undefined {
  const from = clockTime(opens);
  const to = clockTime(closes);
  if (from === undefined || to === undefined || from === to) return undefined;
  return { opens: from, closes: to === "00:00" ? "24:00" : to };
}

const spell = (intervals: readonly Interval[]): string =>
  intervals.length === 0 ? "off" : intervals.map((i) => `${i.opens}-${i.closes}`).join(",");

const ALL_DAY = "00:00-24:00";

/**
 * A week of opening hours, Monday first, in the OSM `opening_hours` grammar:
 * consecutive days with the same hours share a rule, a day without intervals
 * is `off`, and public holidays, when given and not the same as every
 * weekday, follow as `PH`. A week open all day every day, holidays included,
 * is `24/7`. Undefined when the week is closed throughout.
 */
export function osmOpeningHours(
  week: readonly (readonly Interval[])[],
  holidays?: readonly Interval[],
): string | undefined {
  if (week.length !== DAYS.length) throw new Error("a week has seven days");
  const days = week.map(spell);
  const holiday = holidays === undefined ? undefined : spell(holidays);
  if (days.every((d) => d === "off")) return undefined;
  if (days.every((d) => d === ALL_DAY) && (holiday === undefined || holiday === ALL_DAY)) {
    return "24/7";
  }
  const rules: { from: string; to: string; hours: string }[] = [];
  days.forEach((hours, i) => {
    const last = rules.at(-1);
    if (last?.hours === hours) last.to = DAYS[i] ?? "";
    else rules.push({ from: DAYS[i] ?? "", to: DAYS[i] ?? "", hours });
  });
  const spelled = rules.map(({ from, to, hours }) =>
    from === to ? `${from} ${hours}` : `${from}-${to} ${hours}`,
  );
  // Holidays the same as every weekday need no rule of their own.
  if (holiday !== undefined && !days.every((d) => d === holiday)) spelled.push(`PH ${holiday}`);
  return spelled.join("; ");
}
