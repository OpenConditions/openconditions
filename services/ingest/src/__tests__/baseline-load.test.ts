import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { loadBaselineMap } from "../pipeline/baseline-store.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

async function seedBaseline(
  sensorKey: string,
  dowB: number,
  todB: number,
  ff: number,
  method: string
): Promise<void> {
  await sql`
    INSERT INTO conditions.sensor_baseline
      (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
    VALUES (${sensorKey}, 'src', ${dowB}, ${todB}, ${ff}, ${method}, 50, now())`;
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

describe("loadBaselineMap", () => {
  it("prefers specific-bucket derived, then native>derived>osm at the overall row", async () => {
    await seedBaseline("src:a", 0, 14, 88, "derived"); // specific bucket
    await seedBaseline("src:a", -1, -1, 70, "derived"); // overall (loses to specific)
    await seedBaseline("src:b", -1, -1, 60, "derived");
    await seedBaseline("src:b", -1, -1, 62, "native"); // native wins at overall
    await seedBaseline("src:c", -1, -1, 50, "osm_maxspeed");
    await seedBaseline("src:c", -1, -1, 55, "derived"); // derived beats osm

    const map = await loadBaselineMap(sql, "src", () => "2026-03-04T14:00:00Z");
    expect(map.get("src:a")).toEqual({ kph: 88, method: "derived" });
    expect(map.get("src:b")).toEqual({ kph: 62, method: "native" });
    expect(map.get("src:c")).toEqual({ kph: 55, method: "derived" });
  }, 30_000);

  it("only returns rows for the requested source", async () => {
    await seedBaseline("src:only", -1, -1, 42, "derived");
    await sql`
      INSERT INTO conditions.sensor_baseline
        (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
      VALUES ('other:x', 'other-src', -1, -1, 99, 'derived', 50, now())`;

    const map = await loadBaselineMap(sql, "src", () => "2026-03-04T14:00:00Z");
    expect(map.has("other:x")).toBe(false);
    expect(map.get("src:only")).toEqual({ kph: 42, method: "derived" });
  }, 30_000);
});
