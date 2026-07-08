import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import type { Observation } from "@openconditions/core";
import { writeSpeedSamples } from "../pipeline/baseline-store.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

function flow(id: string, speedKph: number | undefined): Observation {
  return {
    id,
    source: "src",
    sourceFormat: "fintraffic-tms-json",
    domain: "roads",
    kind: "measurement",
    metric: "flow",
    aggregation: "live",
    status: "active",
    geometry: { type: "Point", coordinates: [24.9, 60.2] },
    los: "unknown",
    ...(speedKph != null ? { speedKph } : {}),
    origin: { kind: "feed", attribution: { provider: "t", license: "CC-BY-4.0" } },
    dataUpdatedAt: "2026-03-04T14:30:00Z",
    fetchedAt: "2026-03-04T14:31:00Z",
    isStale: false,
  } as unknown as Observation;
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

describe("writeSpeedSamples", () => {
  it("appends one row per flow with a speed, in UTC dow/tod buckets", async () => {
    const written = await writeSpeedSamples(
      sql,
      "src",
      [flow("src:a", 88), flow("src:b", undefined), flow("src:c", 40)],
      () => "2026-03-04T14:31:00Z",
      300
    );
    expect(written).toBe(2);
    const rows = await sql<
      { sensor_key: string; dow: number; tod_hour: number; speed_kph: number }[]
    >`
      SELECT sensor_key, dow, tod_hour, speed_kph FROM conditions.sensor_speed_sample
      WHERE source = 'src' ORDER BY sensor_key`;
    expect(rows.map((r) => r.sensor_key)).toEqual(["src:a", "src:c"]);
    // 2026-03-04 is a Wednesday → getUTCDay() === 3; 14:30Z → hour 14.
    expect(rows[0]!.dow).toBe(3);
    expect(rows[0]!.tod_hour).toBe(14);
    expect(rows[0]!.speed_kph).toBe(88);
  }, 30_000);

  it("is idempotent per (sensor_key, observed_at): a repeated sample yields one row", async () => {
    // flow("dup:1", …) has a fixed dataUpdatedAt, so both writes share the same
    // quantized (sensor_key, observed_at) — the second is dropped by ON CONFLICT.
    await writeSpeedSamples(sql, "dup", [flow("dup:1", 70)], () => "2026-03-04T14:31:00Z", 300);
    await writeSpeedSamples(sql, "dup", [flow("dup:1", 70)], () => "2026-03-04T14:31:00Z", 300);
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.sensor_speed_sample WHERE sensor_key = 'dup:1'`;
    expect(rows[0]!.n).toBe(1);
  }, 30_000);

  it("filters out non-positive and absurd speeds from the baseline history (defense-in-depth)", async () => {
    // A genuine standstill (0) still classifies as congestion at the flow.ts
    // LOS layer (unaffected by this filter), but must not drag the derived p85
    // baseline down; an implausible reading (>= ABSURD_SPEED_KPH) must not
    // inflate it either. Only a plausible positive speed is persisted.
    const written = await writeSpeedSamples(
      sql,
      "filt",
      [flow("filt:zero", 0), flow("filt:absurd", 300), flow("filt:ok", 55)],
      () => "2026-03-04T14:31:00Z",
      300
    );
    expect(written).toBe(1);
    const rows = await sql<{ sensor_key: string }[]>`
      SELECT sensor_key FROM conditions.sensor_speed_sample
      WHERE source = 'filt' ORDER BY sensor_key`;
    expect(rows.map((r) => r.sensor_key)).toEqual(["filt:ok"]);
  }, 30_000);

  it("quantizes now()-fallback samples to one row per sensor per cadence bucket", async () => {
    // A timestamp-less measurement falls back to now(); two polls a few minutes
    // apart but within one 300s cadence bucket floor to the same observed_at, so
    // ON CONFLICT keeps exactly one row (bounding the degenerate now() case).
    const tsless = { ...flow("q:1", 65) } as Record<string, unknown>;
    delete tsless["dataUpdatedAt"];
    delete tsless["fetchedAt"];
    await writeSpeedSamples(
      sql,
      "q",
      [tsless as unknown as Observation],
      () => "2026-03-04T14:31:00Z",
      300
    );
    await writeSpeedSamples(
      sql,
      "q",
      [tsless as unknown as Observation],
      () => "2026-03-04T14:33:00Z",
      300
    );
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.sensor_speed_sample WHERE sensor_key = 'q:1'`;
    expect(rows[0]!.n).toBe(1);
  }, 30_000);
});
