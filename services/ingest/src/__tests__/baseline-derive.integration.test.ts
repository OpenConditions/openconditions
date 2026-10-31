import { SPEED_BIN_WIDTH_KPH } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveBaselines } from "../pipeline/baseline-derive.js";
import { seedSpeedHour } from "./helpers/flow-series.js";

let db: TestDatabase;
let sql: postgres.Sql;

// Pin base to the top of the hour so the +i-second offsets never spill into an
// adjacent hour.
function inWindowBase(daysAgo: number): Date {
  const base = new Date(Date.now() - daysAgo * 86_400_000);
  base.setUTCMinutes(0, 0, 0);
  return base;
}

async function seed(site: string, speeds: number[], base: Date): Promise<string> {
  return seedSpeedHour(sql, "src", site, speeds, base);
}

beforeAll(async () => {
  db = await createTestDatabase({ pool: { max: 3 } });
  sql = db.sql;
});

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("deriveBaselines", () => {
  it("upserts the overall derived row at the 85th percentile, and no row per weekday and hour", async () => {
    const base = inWindowBase(7); // 7 days ago → safely inside the 28-day window
    const speeds = Array.from({ length: 40 }, (_, i) => 60 + i); // 60..99
    const key = await seed("x", speeds, base);

    const { upserted } = await deriveBaselines(sql, { windowDays: 28, minSamples: 30 });
    expect(upserted).toBeGreaterThanOrEqual(1);

    const rows = await sql<
      {
        dow_bucket: number;
        tod_bucket: number;
        free_flow_kph: number;
        method: string;
        sample_count: number;
      }[]
    >`
      SELECT dow_bucket, tod_bucket, free_flow_kph, method, sample_count
        FROM conditions.sensor_baseline WHERE subject_key = ${key}`;
    expect(rows).toHaveLength(1);
    const [overall] = rows;
    expect(overall).toMatchObject({
      dow_bucket: -1,
      tod_bucket: -1,
      method: "derived",
      sample_count: 40,
    });
    // percentile_cont(0.85) over 60..99 == 60 + 0.85*39 == 93.15; the histogram
    // resolves to the containing bin's midpoint, so it lands within one bin.
    expect(overall!.free_flow_kph).toBeGreaterThan(93.15 - SPEED_BIN_WIDTH_KPH);
    expect(overall!.free_flow_kph).toBeLessThan(93.15 + SPEED_BIN_WIDTH_KPH);
  }, 60_000);

  it("merges a site's hours across weekdays and hours of the day", async () => {
    const weekday = inWindowBase(9);
    const later = new Date(weekday.getTime() + 2 * 86_400_000 + 5 * 3_600_000);
    const key = await seed(
      "spread",
      Array.from({ length: 20 }, () => 50),
      weekday,
    );
    await seed(
      "spread",
      Array.from({ length: 20 }, () => 110),
      later,
    );
    await deriveBaselines(sql, { windowDays: 28, minSamples: 30 });
    const [overall] = await sql<{ free_flow_kph: number; sample_count: number }[]>`
      SELECT free_flow_kph, sample_count FROM conditions.sensor_baseline
       WHERE subject_key = ${key} AND dow_bucket = -1 AND tod_bucket = -1`;
    // Neither hour has the 30 samples on its own; together they do.
    expect(overall!.sample_count).toBe(40);
    expect(overall!.free_flow_kph).toBe(111);
  }, 30_000);

  it("derives every site when the sites take more than one batch", async () => {
    const base = inWindowBase(4);
    const keys: string[] = [];
    for (const [site, speed] of [
      ["batch-a", 70],
      ["batch-b", 90],
      ["batch-c", 120],
    ] as const) {
      keys.push(
        await seed(
          site,
          Array.from({ length: 30 }, () => speed),
          base,
        ),
      );
    }
    await sql`DELETE FROM conditions.sensor_baseline WHERE subject_key = ANY(${keys})`;
    await deriveBaselines(sql, { windowDays: 28, minSamples: 30, batchSites: 2 });
    const rows = await sql<{ subject_key: string; free_flow_kph: number }[]>`
      SELECT subject_key, free_flow_kph FROM conditions.sensor_baseline
       WHERE subject_key = ANY(${keys}) ORDER BY subject_key`;
    expect(rows.map((r) => [r.subject_key, r.free_flow_kph])).toEqual([
      [keys[0], 71],
      [keys[1], 91],
      [keys[2], 121],
    ]);
  }, 30_000);

  it("skips an in-window bucket seeded below minSamples via the HAVING clause", async () => {
    // In-window but only 3 rows: excluded by HAVING count >= minSamples, NOT by
    // the time window — so this fails (would produce a row) if HAVING were dropped.
    const key = await seed("sparse", [70, 72, 74], inWindowBase(5));
    await deriveBaselines(sql, { windowDays: 28, minSamples: 30 });
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.sensor_baseline WHERE subject_key = ${key}`;
    expect(rows[0]!.n).toBe(0);
  }, 30_000);

  it("ignores standstills: a queue's zeros neither drag the free flow down nor make up the count", async () => {
    const base = inWindowBase(3);
    const free = Array.from({ length: 30 }, (_, i) => 100 + (i % 10)); // 100..109
    const key = await seed("queue", [...free, ...Array.from({ length: 40 }, () => 0.5)], base);
    await deriveBaselines(sql, { windowDays: 28, minSamples: 30 });
    const [overall] = await sql<{ free_flow_kph: number; sample_count: number }[]>`
      SELECT free_flow_kph, sample_count FROM conditions.sensor_baseline
       WHERE subject_key = ${key} AND dow_bucket = -1 AND tod_bucket = -1`;
    expect(overall!.sample_count).toBe(30);
    expect(overall!.free_flow_kph).toBeGreaterThan(105);

    const sparse = await seed(
      "mostly-stopped",
      [...free.slice(0, 20), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      base,
    );
    await deriveBaselines(sql, { windowDays: 28, minSamples: 30 });
    expect(
      await sql`SELECT 1 FROM conditions.sensor_baseline WHERE subject_key = ${sparse}`,
    ).toEqual([]);
  }, 30_000);
});
