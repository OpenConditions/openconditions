import { runMigrations } from "@openconditions/core/server";
import { SPEED_BIN_WIDTH_KPH } from "@openconditions/storage";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveBaselines } from "../pipeline/baseline-derive.js";
import { seedSpeedHour } from "./helpers/flow-series.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

// Pin base to the top of the hour so the +i-second offsets never spill into an
// adjacent hour/day bucket, and derive the expected dow/tod buckets from it.
function inWindowBase(daysAgo: number): Date {
  const base = new Date(Date.now() - daysAgo * 86_400_000);
  base.setUTCMinutes(0, 0, 0);
  return base;
}

function buckets(base: Date): { dowBucket: number; tod: number } {
  const dow = base.getUTCDay();
  return { dowBucket: dow === 0 || dow === 6 ? 1 : 0, tod: base.getUTCHours() };
}

async function seed(site: string, speeds: number[], base: Date): Promise<string> {
  return seedSpeedHour(sql, "src", site, speeds, base);
}

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("deriveBaselines", () => {
  it("upserts specific-bucket + overall derived rows at the 85th percentile", async () => {
    const base = inWindowBase(7); // 7 days ago → safely inside the 28-day window
    const { dowBucket, tod } = buckets(base);
    const speeds = Array.from({ length: 40 }, (_, i) => 60 + i); // 60..99
    const key = await seed("x", speeds, base);

    const { upserted } = await deriveBaselines(sql, { windowDays: 28, minSamples: 30 });
    expect(upserted).toBeGreaterThanOrEqual(2);

    const specific = await sql<{ free_flow_kph: number; method: string; sample_count: number }[]>`
      SELECT free_flow_kph, method, sample_count FROM conditions.sensor_baseline
      WHERE subject_key = ${key} AND dow_bucket = ${dowBucket} AND tod_bucket = ${tod}`;
    expect(specific[0]!.method).toBe("derived");
    expect(specific[0]!.sample_count).toBe(40);
    // percentile_cont(0.85) over 60..99 == 60 + 0.85*39 == 93.15; the histogram
    // resolves to the containing bin's midpoint, so it lands within one bin.
    expect(specific[0]!.free_flow_kph).toBeGreaterThan(93.15 - SPEED_BIN_WIDTH_KPH);
    expect(specific[0]!.free_flow_kph).toBeLessThan(93.15 + SPEED_BIN_WIDTH_KPH);

    const overall = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.sensor_baseline
      WHERE subject_key = ${key} AND dow_bucket = -1 AND tod_bucket = -1 AND method = 'derived'`;
    expect(overall[0]!.n).toBe(1);
  }, 60_000);

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
