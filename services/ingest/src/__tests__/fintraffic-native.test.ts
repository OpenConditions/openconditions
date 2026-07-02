import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import type { FeedSource } from "@openconditions/roads";
import { updateFintrafficNativeBaselines } from "../pipeline/fintraffic-native.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const stations = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: 23001,
      properties: {},
      geometry: { type: "Point", coordinates: [24.9, 60.2] },
    },
  ],
});

const constants = JSON.stringify({
  id: 23001,
  sensorConstantValues: [{ name: "VVAPAAS1", value: 118, validFrom: "01-01", validTo: "12-31" }],
});

const feed = {
  id: "fintraffic-tms-fi",
  stationRegistry: {
    url: "https://tie.digitraffic.fi/api/tms/v1/stations",
    format: "fintraffic-stations",
  },
} as unknown as FeedSource;

const fetchFn = (async (url: string) =>
  new Response(String(url).includes("sensor-constants") ? constants : stations, {
    status: 200,
  })) as unknown as typeof fetch;

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

describe("updateFintrafficNativeBaselines", () => {
  it("upserts native overall baselines from VVAPAAS constants, keyed to match the flow parser", async () => {
    const { updated } = await updateFintrafficNativeBaselines(sql, feed, {
      fetch: fetchFn,
      now: () => new Date("2026-07-15T00:00:00Z"),
      batchCap: 50,
    });
    expect(updated).toBe(1);

    const rows = await sql<
      { free_flow_kph: number; method: string; dow_bucket: number; tod_bucket: number }[]
    >`
      SELECT free_flow_kph, method, dow_bucket, tod_bucket FROM conditions.sensor_baseline
      WHERE sensor_key = 'fintraffic-tms-fi:23001-1'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe("native");
    expect(rows[0]!.dow_bucket).toBe(-1);
    expect(rows[0]!.tod_bucket).toBe(-1);
    expect(rows[0]!.free_flow_kph).toBe(118);
  }, 60_000);

  it("upserts on re-run (ON CONFLICT DO UPDATE) rather than duplicating rows", async () => {
    const updatedConstants = JSON.stringify({
      id: 23001,
      sensorConstantValues: [
        { name: "VVAPAAS1", value: 130, validFrom: "01-01", validTo: "12-31" },
      ],
    });
    const bumpedFetch = (async (url: string) =>
      new Response(String(url).includes("sensor-constants") ? updatedConstants : stations, {
        status: 200,
      })) as unknown as typeof fetch;

    await updateFintrafficNativeBaselines(sql, feed, {
      fetch: bumpedFetch,
      now: () => new Date("2026-07-15T00:00:00Z"),
      batchCap: 50,
    });

    const rows = await sql<{ free_flow_kph: number }[]>`
      SELECT free_flow_kph FROM conditions.sensor_baseline
      WHERE sensor_key = 'fintraffic-tms-fi:23001-1'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.free_flow_kph).toBe(130);
  }, 30_000);

  it("is tolerant of a per-station constants fetch failure and does not throw", async () => {
    const stationsWithTwo = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 23001,
          properties: {},
          geometry: { type: "Point", coordinates: [24.9, 60.2] },
        },
        {
          type: "Feature",
          id: 99999,
          properties: {},
          geometry: { type: "Point", coordinates: [25.0, 60.3] },
        },
      ],
    });
    const flaky = (async (url: string) => {
      if (String(url).includes("99999")) throw new Error("network down");
      if (String(url).includes("sensor-constants")) return new Response(constants, { status: 200 });
      return new Response(stationsWithTwo, { status: 200 });
    }) as unknown as typeof fetch;

    const { updated } = await updateFintrafficNativeBaselines(sql, feed, {
      fetch: flaky,
      now: () => new Date("2026-07-15T00:00:00Z"),
      batchCap: 50,
    });
    // The failing station is skipped; the healthy one still updates.
    expect(updated).toBe(1);
  }, 30_000);

  it("never throws when the station-registry fetch itself fails", async () => {
    const bad = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const { updated } = await updateFintrafficNativeBaselines(sql, feed, {
      fetch: bad,
      now: () => new Date(),
      batchCap: 50,
    });
    expect(updated).toBe(0);
  }, 30_000);

  it("returns 0 and does nothing when the feed declares no station registry", async () => {
    const noRegistry = { id: "fintraffic-tms-fi" } as unknown as FeedSource;
    const { updated } = await updateFintrafficNativeBaselines(sql, noRegistry, {
      fetch: fetchFn,
      now: () => new Date(),
      batchCap: 50,
    });
    expect(updated).toBe(0);
  }, 30_000);

  it("respects batchCap, never requesting more stations than the cap", async () => {
    const manyStations = JSON.stringify({
      type: "FeatureCollection",
      features: Array.from({ length: 5 }, (_, i) => ({
        type: "Feature",
        id: 30000 + i,
        properties: {},
        geometry: { type: "Point", coordinates: [24.9, 60.2] },
      })),
    });
    let constantsRequests = 0;
    const counting = (async (url: string) => {
      if (String(url).includes("sensor-constants")) {
        constantsRequests += 1;
        return new Response(constants, { status: 200 });
      }
      return new Response(manyStations, { status: 200 });
    }) as unknown as typeof fetch;

    await updateFintrafficNativeBaselines(sql, feed, {
      fetch: counting,
      now: () => new Date("2026-07-15T00:00:00Z"),
      batchCap: 2,
    });
    expect(constantsRequests).toBe(2);
  }, 30_000);
});
