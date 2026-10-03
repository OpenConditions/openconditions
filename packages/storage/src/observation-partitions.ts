import type { PropertyEntry, Registry } from "@openconditions/model";
import type postgres from "postgres";

const DAY_MS = 86_400_000;

/**
 * How many days of raw readings a property keeps: its registry `rawDays`, or
 * 0 for a property that keeps every reading. Undefined for a property that
 * keeps no history at all (`latestOnly`, camera images).
 */
export function retentionDaysOf(entry: Pick<PropertyEntry, "retention">): number | undefined {
  if (entry.retention?.latestOnly) return undefined;
  return entry.retention?.rawDays ?? 0;
}

/** Every retention class the registry's properties use, ascending. */
export function retentionClasses(registry: Registry): number[] {
  const classes = new Set<number>();
  for (const p of registry.properties()) {
    const days = retentionDaysOf(p);
    if (days !== undefined) classes.add(days);
  }
  return [...classes].sort((a, b) => a - b);
}

const dayStart = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll("-", "");
const monthStart = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const nextMonth = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
const iso = (t: number) => new Date(t).toISOString();

/** The partitions one retention class needs around `now`: [name, from, to) in ms. */
function wanted(days: number, now: number, aheadDays: number): [string, number, number][] {
  const out: [string, number, number][] = [];
  if (days === 0) {
    // Keep-everything series are sparse: one partition per month, from the
    // previous month (late readings) to the month the look-ahead reaches.
    for (let m = monthStart(monthStart(now) - 1); m <= now + aheadDays * DAY_MS; m = nextMonth(m)) {
      out.push([`observation_r0_m${ymd(m).slice(0, 6)}`, m, nextMonth(m)]);
    }
    return out;
  }
  for (let d = dayStart(now) - days * DAY_MS; d <= now + aheadDays * DAY_MS; d += DAY_MS) {
    out.push([`observation_r${days}_d${ymd(d)}`, d, d + DAY_MS]);
  }
  return out;
}

/** How far ahead history partitions exist: forecasts and next-day prices start in the future. */
export const PARTITION_AHEAD_DAYS = 16;

/**
 * Maintenance keeps a day more on each side than a writer counts on: it runs
 * hourly, so a write can come up to an hour after the last run (and an hour
 * later still if a run is skipped), when the writer's window has already moved.
 */
const MAINTENANCE_MARGIN_DAYS = 1;

/**
 * Whether the partitions {@link ensureObservationPartitions} keeps around
 * `now` hold a reading of this retention class starting at `start`. A
 * writer checks this first: a reading outside is past its retention or too
 * far ahead, and one such row would fail a whole batch.
 */
export function partitionCovers(
  days: number,
  start: number,
  now: number,
  aheadDays = PARTITION_AHEAD_DAYS,
): boolean {
  const windows = wanted(days, now, aheadDays);
  return start >= windows[0]![1] && start < windows.at(-1)![2];
}

/**
 * Creates the history partitions every retention class needs: each class's
 * list partition, then its range partitions from the start of its retention
 * window to `aheadDays` ahead. Idempotent; returns the partitions it created.
 */
export async function ensureObservationPartitions(
  sql: postgres.Sql,
  opts: { classes: readonly number[]; now: Date; aheadDays?: number },
): Promise<string[]> {
  const now = opts.now.getTime();
  const aheadDays = opts.aheadDays ?? PARTITION_AHEAD_DAYS;
  const existing = new Set(await partitionNames(sql));
  const created: string[] = [];
  for (const days of opts.classes) {
    const parent = `observation_r${days}`;
    if (!existing.has(parent)) {
      await sql.unsafe(
        `CREATE TABLE conditions.${parent} PARTITION OF conditions.observation
           FOR VALUES IN (${days}) PARTITION BY RANGE (phenomenon_start)`,
      );
      created.push(parent);
    }
    for (const [name, from, to] of wanted(days, now, aheadDays + MAINTENANCE_MARGIN_DAYS)) {
      if (existing.has(name)) continue;
      await sql.unsafe(
        `CREATE TABLE conditions.${name} PARTITION OF conditions.${parent}
           FOR VALUES FROM ('${iso(from)}') TO ('${iso(to)}')`,
      );
      created.push(name);
    }
  }
  return created;
}

/**
 * Drops the daily partitions whose every reading is older than its class's
 * retention. A day of a class holding a property that rolls up stays until
 * the rollup has finalized past its end, unless it holds no reading: its
 * readings are the rollup's only input. Keep-everything partitions are never
 * dropped. Returns the partitions it dropped.
 */
export async function dropExpiredObservationPartitions(
  sql: postgres.Sql,
  opts: { now: Date; registry: Registry },
): Promise<string[]> {
  const now = opts.now.getTime();
  const rolledUp = new Map<number, Set<string>>();
  for (const p of opts.registry.properties()) {
    const days = retentionDaysOf(p);
    const period = p.retention?.rollup?.period;
    if (days === undefined || period === undefined) continue;
    rolledUp.set(days, (rolledUp.get(days) ?? new Set()).add(period));
  }
  const progress = await sql<{ period: string; finalized_before: Date }[]>`
    SELECT period, finalized_before FROM conditions.observation_rollup_progress`;
  const frontiers = new Map(progress.map((r) => [r.period, r.finalized_before.getTime()]));
  const dropped: string[] = [];
  for (const name of await partitionNames(sql)) {
    const m = /^observation_r(\d+)_d(\d{4})(\d{2})(\d{2})$/.exec(name);
    if (m === null) continue;
    const days = Number(m[1]);
    const end = Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4])) + DAY_MS;
    if (days === 0 || end > now - (days + MAINTENANCE_MARGIN_DAYS) * DAY_MS) continue;
    const pending = [...(rolledUp.get(days) ?? [])].some((p) => (frontiers.get(p) ?? 0) < end);
    if (pending) {
      const [held] = await sql.unsafe<{ any: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM conditions.${name}) AS any`,
      );
      if (held?.any) continue;
    }
    await sql.unsafe(`DROP TABLE conditions.${name}`);
    dropped.push(name);
  }
  return dropped;
}

/** Every partition below `conditions.observation`, at any depth. */
async function partitionNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT inhrelid FROM pg_inherits WHERE inhparent = 'conditions.observation'::regclass
      UNION ALL
      SELECT i.inhrelid FROM pg_inherits i JOIN tree t ON i.inhparent = t.inhrelid
    )
    SELECT c.relname AS name FROM tree JOIN pg_class c ON c.oid = tree.inhrelid
    ORDER BY c.relname`;
  return rows.map((r) => r.name);
}
