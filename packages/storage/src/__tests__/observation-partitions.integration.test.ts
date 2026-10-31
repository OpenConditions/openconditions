import {
  buildRegistry,
  defineDomain,
  defineProperty,
  kernelModule,
  type Retention,
} from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeClosedObservationPartitions,
  dropExpiredObservationPartitions,
  ensureObservationPartitions,
  partitionCoverage,
  partitionCovers,
  retentionClasses,
  retentionDaysOf,
} from "../observation-partitions.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

const NOW = new Date("2026-10-01T12:00:00Z");

/** A registry whose properties keep the retention classes `retentions` declare. */
function registryKeeping(retentions: Record<string, Retention | undefined>) {
  return buildRegistry([
    kernelModule,
    {
      name: "test",
      entries: [
        defineDomain({ code: "roads", description: "x" }),
        ...Object.entries(retentions).map(([code, retention]) =>
          defineProperty({
            code,
            domain: "roads",
            version: "1.0",
            description: "x",
            result: { type: "quantity", unit: "km/h" },
            subjects: [{ kind: "location" }],
            ...(retention === undefined ? {} : { retention }),
          }),
        ),
      ],
    },
  ]);
}

// Classes 0, 2 (rolled up), 3 and 5, as the maintenance below exercises them.
const registry = registryKeeping({
  "t.every": undefined,
  "t.speed": { rawDays: 2, rollup: { period: "hourly" } },
  "t.three": { rawDays: 3 },
  "t.five": { rawDays: 5 },
});

async function insertReading(retentionDays: number, start: string) {
  await sql`
    INSERT INTO conditions.observation (series_id, retention_days, phenomenon_start,
      fetched_at, recorded_at, temporality, aggregation, value_num)
    VALUES (1, ${retentionDays}, ${start}, now(), now(), 'live', 'mean', 42)`;
}

describe("partitionCovers", () => {
  const now = NOW.getTime();
  const at = (iso: string) => Date.parse(iso);

  it("matches the days a finite class keeps and the look-ahead", () => {
    expect(partitionCovers(2, at("2026-09-29T00:00:00Z"), now, 1)).toBe(true);
    expect(partitionCovers(2, at("2026-09-28T23:59:59Z"), now, 1)).toBe(false);
    expect(partitionCovers(2, at("2026-10-02T23:59:59Z"), now, 1)).toBe(true);
    expect(partitionCovers(2, at("2026-10-03T00:00:00Z"), now, 1)).toBe(false);
  });

  it("matches the months the keep-everything class keeps", () => {
    expect(partitionCovers(0, at("2026-09-01T00:00:00Z"), now, 1)).toBe(true);
    expect(partitionCovers(0, at("2026-08-31T23:59:59Z"), now, 1)).toBe(false);
    expect(partitionCovers(0, at("2026-10-31T23:59:59Z"), now, 1)).toBe(true);
  });

  it("answers as partitionCovers with each class's window worked out once", () => {
    const covers = partitionCoverage(now);
    const edges = [
      "2026-08-31T23:59:59Z",
      "2026-09-01T00:00:00Z",
      "2026-09-28T23:59:59Z",
      "2026-09-29T00:00:00Z",
      "2026-10-17T23:59:59Z",
      "2026-10-18T00:00:00Z",
      "2026-11-30T23:59:59Z",
      "2026-12-01T00:00:00Z",
    ].map(at);
    for (const days of [0, 2, 30, 0, 2])
      for (const start of edges) {
        expect(covers(days, start)).toBe(partitionCovers(days, start, now));
      }
  });
});

describe("retention classes", () => {
  it("come from the registry: raw days, 0 to keep everything, none for latest-only", () => {
    expect(retentionDaysOf(registry.property("t.speed")!)).toBe(2);
    expect(retentionDaysOf(registry.property("t.every")!)).toBe(0);
    expect(retentionDaysOf({ retention: { latestOnly: true } })).toBeUndefined();
    expect(retentionDaysOf({ retention: { changeOnly: true, latestOnly: true } })).toBeUndefined();
    expect(retentionClasses(registry)).toEqual([0, 2, 3, 5]);
  });

  it("are the speed's raw day alone in production", () => {
    const production = productionRegistry();
    expect(retentionDaysOf(production.property("traffic.speed")!)).toBe(1);
    expect(retentionClasses(production)).toEqual([1]);
  });
});

describe("observation partitions", () => {
  it("cover each class's window and the look-ahead, a day to spare, and nothing else", async () => {
    const created = await ensureObservationPartitions(sql, {
      classes: [0, 2],
      now: NOW,
      aheadDays: 1,
    });
    expect(created).toEqual([
      "observation_r0",
      "observation_r0_m202609",
      "observation_r0_m202610",
      "observation_r2",
      "observation_r2_d20260929",
      "observation_r2_d20260930",
      "observation_r2_d20261001",
      "observation_r2_d20261002",
      "observation_r2_d20261003",
    ]);
    await insertReading(2, "2026-09-29T00:00:00Z");
    await insertReading(2, "2026-10-02T23:59:59Z");
    await insertReading(0, "2026-09-01T00:00:00Z");
    await expect(insertReading(2, "2026-10-04T00:00:00Z")).rejects.toThrow(/no partition/);
    await expect(insertReading(7, "2026-10-01T00:00:00Z")).rejects.toThrow(/no partition/);
  });

  it("are created once", async () => {
    expect(
      await ensureObservationPartitions(sql, { classes: [0, 2], now: NOW, aheadDays: 1 }),
    ).toEqual([]);
  });

  it("drop whole days once every reading in them is past retention, never keep-everything months", async () => {
    const drop = (at: string) =>
      dropExpiredObservationPartitions(sql, { now: new Date(at), registry });
    await sql`INSERT INTO conditions.observation_rollup_progress (period, finalized_before)
      VALUES ('hourly', '2026-10-02T00:00:00Z')`;
    expect(await drop("2026-10-02T00:30:00Z")).toEqual([]);
    // The 29th's readings are all two days old by the 1st at midnight; an hour
    // later than that (a poll begun before maintenance ran) it goes.
    expect(await drop("2026-10-02T12:00:00Z")).toEqual(["observation_r2_d20260929"]);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM conditions.observation`;
    expect(count).toBe(2);
    expect(await drop("2027-06-01T00:00:00Z")).not.toContain("observation_r0_m202609");
    await sql`DELETE FROM conditions.observation_rollup_progress`;
  });

  it("keep a day of a rolled-up property until the rollup has passed it, unless it holds nothing", async () => {
    // Class 2 holds t.speed, which rolls up hourly.
    await ensureObservationPartitions(sql, { classes: [2], now: NOW, aheadDays: 1 });
    await insertReading(2, "2026-09-30T08:00:00Z");
    const drop = (at: string) =>
      dropExpiredObservationPartitions(sql, { now: new Date(at), registry });
    expect(await drop("2026-10-05T00:30:00Z")).toEqual([
      "observation_r2_d20260929",
      "observation_r2_d20261001",
    ]);
    await sql`INSERT INTO conditions.observation_rollup_progress (period, finalized_before)
      VALUES ('hourly', '2026-09-30T23:00:00Z')`;
    expect(await drop("2026-10-05T00:30:00Z")).toEqual([]);
    await sql`UPDATE conditions.observation_rollup_progress SET finalized_before = '2026-10-01T00:00:00Z'`;
    expect(await drop("2026-10-05T00:30:00Z")).toEqual(["observation_r2_d20260930"]);
    await sql`DELETE FROM conditions.observation_rollup_progress`;
  });
});

describe("partition maintenance an hour away from a write", () => {
  const HOUR = 3_600_000;
  const inserted = new Set<string>();

  /**
   * Inserts a reading at every hour the writer counts as covered at `writerAt`,
   * in one statement: it fails as a whole if any of those hours has no partition.
   */
  async function writeEverythingCovered(days: number, writerAt: string) {
    const at = Date.parse(writerAt);
    const starts: string[] = [];
    for (let t = at - (days + 2) * 24 * HOUR; t < at + 20 * 24 * HOUR; t += HOUR) {
      const start = new Date(t).toISOString();
      if (!partitionCovers(days, t, at) || inserted.has(`${days}${start}`)) continue;
      inserted.add(`${days}${start}`);
      starts.push(start);
    }
    expect(starts.length).toBeGreaterThan(0);
    await sql`
      INSERT INTO conditions.observation (series_id, retention_days, phenomenon_start,
        fetched_at, recorded_at, temporality, aggregation, value_num)
      SELECT 1, ${days}, start, now(), now(), 'live', 'mean', 42
        FROM unnest(${starts}::timestamptz[]) AS start`;
  }

  async function maintain(days: number, at: string) {
    await ensureObservationPartitions(sql, { classes: [days], now: new Date(at) });
    await dropExpiredObservationPartitions(sql, { now: new Date(at), registry });
  }

  it("holds the look-ahead a writer counts on just after midnight, before the next run", async () => {
    await maintain(5, "2026-11-01T23:05:00Z");
    await writeEverythingCovered(5, "2026-11-02T00:02:00Z");
  });

  it("keeps the oldest day a poll begun before midnight still counts on", async () => {
    await maintain(3, "2026-11-01T23:05:00Z");
    await maintain(3, "2026-11-02T00:05:00Z");
    await writeEverythingCovered(3, "2026-11-01T23:59:00Z");
  });

  it("holds next month's keep-everything partition before the look-ahead reaches it", async () => {
    await maintain(0, "2026-11-14T23:05:00Z");
    await writeEverythingCovered(0, "2026-11-15T00:02:00Z");
  });
});

describe("a retention class no property keeps", () => {
  const production = registryKeeping({
    "t.speed": { rawDays: 1, rollup: { period: "hourly" } },
  });
  const partitions = async () =>
    (
      await sql<{ name: string }[]>`
        SELECT relname AS name FROM pg_class
         WHERE relnamespace = 'conditions'::regnamespace AND relkind IN ('r', 'p')
           AND relname ~ '^observation_r[0-9]'
         ORDER BY relname`
    ).map((r) => r.name);

  it("goes whole, but for a day holding readings of a rolled-up property the rollup has not reached", async () => {
    await ensureObservationPartitions(sql, { classes: [1, 7], now: NOW, aheadDays: 1 });
    await sql`
      INSERT INTO conditions.observation_latest (series_id, subject_key, property, source_id,
        subject_kind, reading, template, template_hash, access_mode, result_type,
        effective_from, since_at)
      VALUES (100, 'loc:x', 't.speed', 'src', 'location', '{}', '{}', 'h', 'bulk', 'quantity',
        '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z')`;
    await sql`
      INSERT INTO conditions.observation (series_id, retention_days, phenomenon_start,
        fetched_at, recorded_at, temporality, aggregation, value_num)
      VALUES (100, 7, '2026-10-01T08:00:00Z', now(), now(), 'live', 'mean', 90),
             (1, 7, '2026-09-30T08:00:00Z', now(), now(), 'live', 'mean', 90)`;
    await sql`INSERT INTO conditions.observation_rollup_progress (period, finalized_before)
      VALUES ('hourly', '2026-10-01T06:00:00Z')`;
    const drop = () => dropExpiredObservationPartitions(sql, { now: NOW, registry: production });

    const dropped = await drop();
    expect(dropped).toEqual(
      expect.arrayContaining(["observation_r0", "observation_r0_m202609", "observation_r2"]),
    );
    expect(dropped).toContain("observation_r7_d20260930");
    expect(await partitions()).toEqual([
      "observation_r1",
      "observation_r1_d20260930",
      "observation_r1_d20261001",
      "observation_r1_d20261002",
      "observation_r1_d20261003",
      "observation_r7",
      "observation_r7_d20261001",
    ]);

    await sql`UPDATE conditions.observation_rollup_progress SET finalized_before = '2026-10-01T09:00:00Z'`;
    expect(await drop()).toEqual(["observation_r7_d20261001", "observation_r7"]);
    expect((await partitions()).filter((n) => n.startsWith("observation_r7"))).toEqual([]);
    await sql`DELETE FROM conditions.observation_rollup_progress`;
  });
});

describe("analysis of closed partitions", () => {
  const DAY = 86_400_000;
  // Days ahead of the clock, so that an analysis today comes before the day ends.
  const day = Math.floor(Date.now() / DAY) * DAY + 2 * DAY;
  const name = (t: number) =>
    `observation_r9_d${new Date(t).toISOString().slice(0, 10).replaceAll("-", "")}`;
  const before = name(day - DAY);
  const closing = name(day);
  const open = name(day + DAY);

  /**
   * Inserts `n` readings at `at` and waits until the statistics count them: a
   * backend reports its changes when it goes idle, not when it commits.
   */
  async function insert(at: number, n: number) {
    const partition = name(Math.floor(at / DAY) * DAY);
    const changed = async () => {
      const [row] = await sql<{ n: string }[]>`
        SELECT n_mod_since_analyze AS n FROM pg_stat_user_tables WHERE relname = ${partition}`;
      return Number(row?.n ?? 0);
    };
    const expected = (await changed()) + n;
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO conditions.observation (series_id, retention_days, phenomenon_start,
          fetched_at, recorded_at, temporality, aggregation, value_num)
        SELECT g, 9, ${new Date(at).toISOString()}::timestamptz, now(), now(), 'live', 'mean', 42
          FROM generate_series(1, ${n}) g`;
      await tx`SELECT pg_stat_force_next_flush()`;
    });
    for (let tries = 0; (await changed()) < expected; tries++) {
      if (tries === 50) throw new Error(`${partition}: the statistics never counted ${n} readings`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  beforeAll(async () => {
    await ensureObservationPartitions(sql, { classes: [9], now: new Date(day) });
    // Autovacuum stays out: the test decides when each partition was last analyzed.
    for (const p of [before, closing, open]) {
      await sql.unsafe(`ALTER TABLE conditions.${p} SET (autovacuum_enabled = false)`);
    }
    await insert(day - DAY + 3_600_000, 10);
    await insert(day + 3_600_000, 1000);
    // Analyzed while the day is still being written, as autovacuum does.
    await sql.unsafe(`ANALYZE conditions.${closing}`);
    // Its last hours, written after that analysis.
    await insert(day + 23 * 3_600_000, 50);
    await insert(day + DAY + 3_600_000, 10);
  });

  it("analyzes a day written to after its last analysis once it has closed, and a day never analyzed", async () => {
    const analyzed = await analyzeClosedObservationPartitions(sql, {
      now: new Date(day + DAY + 5 * 60_000),
    });
    expect(analyzed).toEqual(expect.arrayContaining([before, closing]));
    expect(analyzed).not.toContain(open);
    const [stats] = await sql<{ reltuples: number }[]>`
      SELECT reltuples FROM pg_class WHERE relname = ${closing}`;
    expect(stats!.reltuples).toBe(1050);
  });

  it("leaves a closed day unchanged since its analysis, and a day still open", async () => {
    const analyzed = await analyzeClosedObservationPartitions(sql, {
      now: new Date(day + DAY + 65 * 60_000),
    });
    expect(analyzed).not.toContain(before);
    expect(analyzed).not.toContain(closing);
    expect(analyzed).not.toContain(open);
  });
});
