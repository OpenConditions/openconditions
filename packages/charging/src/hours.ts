/** One weekly period: day 1 is Monday, 7 Sunday; times `HH:MM` on the site's clock. */
export interface WeeklyPeriod {
  day: number;
  from: string;
  to: string;
}

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

const CLOCK = /^(?:[01]\d|2[0-4]):[0-5]\d$/;

/** `Mo-Fr`, `Mo,We`, `Mo-We,Fr`: consecutive days as ranges. */
function dayList(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const day of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && last[1] === day - 1) last[1] = day;
    else runs.push([day, day]);
  }
  const name = (day: number) => DAYS[day - 1] ?? "";
  return runs
    .map(([from, to]) => {
      if (from === to) return name(from);
      return `${name(from)}${to === from + 1 ? "," : "-"}${name(to)}`;
    })
    .join(",");
}

/**
 * Weekly periods in the OSM `opening_hours` grammar, days with the same hours
 * written together (`Mo-Fr 08:00-18:00; Sa 09:00-14:00`). Every day open the
 * whole day is `24/7`. Undefined when no period is readable.
 */
export function osmOpeningHours(periods: readonly WeeklyPeriod[]): string | undefined {
  const byDay = new Map<number, string[]>();
  for (const { day, from, to } of periods) {
    if (!Number.isInteger(day) || day < 1 || day > 7) continue;
    if (!CLOCK.test(from) || !CLOCK.test(to)) continue;
    const spans = byDay.get(day) ?? [];
    const span = `${from}-${to}`;
    if (!spans.includes(span)) spans.push(span);
    byDay.set(day, spans);
  }
  if (byDay.size === 0) return undefined;
  const wholeDay = (spans: string[]) =>
    spans.length === 1 && (spans[0] === "00:00-24:00" || spans[0] === "00:00-23:59");
  if (byDay.size === 7 && [...byDay.values()].every(wholeDay)) return "24/7";
  const groups = new Map<string, number[]>();
  for (const [day, spans] of [...byDay].sort(([a], [b]) => a - b)) {
    const hours = [...spans].sort().join(",");
    groups.set(hours, [...(groups.get(hours) ?? []), day]);
  }
  return [...groups].map(([hours, days]) => `${dayList(days)} ${hours}`).join("; ");
}
