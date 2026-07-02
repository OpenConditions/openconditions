import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { deriveBaselines } from "../pipeline/baseline-derive.js";

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

async function seed(sensorKey: string, speeds: number[], base: Date): Promise<void> {
  for (let i = 0; i < speeds.length; i++) {
    const observedAt = new Date(base.getTime() + i * 1000); // distinct instant, same bucket
    await sql`
      INSERT INTO conditions.sensor_speed_sample
        (sensor_key, source, observed_at, speed_kph, dow, tod_hour, geom)
      VALUES (${sensorKey}, 'src', ${observedAt}, ${speeds[i]},
        ${observedAt.getUTCDay()}, ${observedAt.getUTCHours()},
        ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Point","coordinates":[0,0]}'), 4326))`;
  }
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
    await seed("src:x", speeds, base);

    const { upserted } = await deriveBaselines(sql, { windowDays: 28, minSamples: 30 });
    expect(upserted).toBeGreaterThanOrEqual(2);

    const specific = await sql<{ free_flow_kph: number; method: string }[]>`
      SELECT free_flow_kph, method FROM conditions.sensor_baseline
      WHERE sensor_key = 'src:x' AND dow_bucket = ${dowBucket} AND tod_bucket = ${tod}`;
    expect(specific[0]!.method).toBe("derived");
    // percentile_cont(0.85) over 60..99 == 60 + 0.85*39 == 93.15
    expect(specific[0]!.free_flow_kph).toBeCloseTo(93.15, 1);

    const overall = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.sensor_baseline
      WHERE sensor_key = 'src:x' AND dow_bucket = -1 AND tod_bucket = -1 AND method = 'derived'`;
    expect(overall[0]!.n).toBe(1);
  }, 60_000);

  it("skips an in-window bucket seeded below minSamples via the HAVING clause", async () => {
    // In-window but only 3 rows: excluded by HAVING count(*) >= minSamples, NOT
    // by the time window — so this fails (would produce a row) if HAVING were dropped.
    await seed("src:sparse", [70, 72, 74], inWindowBase(5));
    await deriveBaselines(sql, { windowDays: 28, minSamples: 30 });
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.sensor_baseline WHERE sensor_key = 'src:sparse'`;
    expect(rows[0]!.n).toBe(0);
  }, 30_000);
});
