import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropExpiredObservationPartitions,
  ensureObservationPartitions,
  partitionCovers,
  retentionClasses,
  retentionDaysOf,
} from "../observation-partitions.js";
import { createTestDatabase } from "./database.integration.js";

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
const registry = productionRegistry();

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
});

describe("retention classes", () => {
  it("come from the registry: raw days, 0 to keep everything, none for latest-only", () => {
    const registry = productionRegistry();
    expect(retentionDaysOf(registry.property("traffic.speed")!)).toBe(3);
    expect(retentionDaysOf(registry.property("camera.image")!)).toBeUndefined();
    expect(retentionDaysOf(registry.property("traffic.los")!)).toBe(7);
    expect(retentionDaysOf(registry.property("device.status")!)).toBe(0);
    expect(retentionClasses(registry)).toEqual(expect.arrayContaining([0, 2, 3, 7, 30]));
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

  it("drop whole days a day after every reading in them is past retention, never keep-everything months", async () => {
    const drop = (at: string) =>
      dropExpiredObservationPartitions(sql, { now: new Date(at), registry });
    await sql`INSERT INTO conditions.observation_rollup_progress (period, finalized_before)
      VALUES ('hourly', '2026-10-02T00:00:00Z')`;
    expect(await drop("2026-10-02T00:30:00Z")).toEqual([]);
    expect(await drop("2026-10-03T00:30:00Z")).toEqual(["observation_r2_d20260929"]);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM conditions.observation`;
    expect(count).toBe(2);
    expect(await drop("2027-06-01T00:00:00Z")).not.toContain("observation_r0_m202609");
    await sql`DELETE FROM conditions.observation_rollup_progress`;
  });

  it("keep a day of a rolled-up property until the rollup has passed it, unless it holds nothing", async () => {
    // Class 2 holds traffic.volume, which rolls up hourly.
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

  /** Inserts a reading at every hour the writer counts as covered at `writerAt`. */
  async function writeEverythingCovered(days: number, writerAt: string) {
    const at = Date.parse(writerAt);
    for (let t = at - (days + 2) * 24 * HOUR; t < at + 20 * 24 * HOUR; t += HOUR) {
      const start = new Date(t).toISOString();
      if (!partitionCovers(days, t, at) || inserted.has(`${days}${start}`)) continue;
      inserted.add(`${days}${start}`);
      await insertReading(days, start);
    }
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
