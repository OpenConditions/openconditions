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

  it("sends the feed's requestHeaders on both the registry and sensor-constants sub-fetches", async () => {
    const seenHeaders: (Record<string, string> | undefined)[] = [];
    const headerFetch = (async (url: string, init?: RequestInit) => {
      seenHeaders.push(init?.headers as Record<string, string> | undefined);
      return new Response(String(url).includes("sensor-constants") ? constants : stations, {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const feedWithHeaders = {
      ...feed,
      requestHeaders: { "Digitraffic-User": "OpenConditions/1.0" },
    } as unknown as FeedSource;

    await updateFintrafficNativeBaselines(sql, feedWithHeaders, {
      fetch: headerFetch,
      now: () => new Date("2026-07-15T00:00:00Z"),
      batchCap: 50,
    });

    // One registry fetch + one sensor-constants fetch, both carrying the header.
    expect(seenHeaders).toHaveLength(2);
    for (const headers of seenHeaders) {
      expect(headers).toEqual({ "Digitraffic-User": "OpenConditions/1.0" });
    }
  }, 30_000);

  describe("station batch prioritization", () => {
    const priorityFeed = {
      id: "fintraffic-tms-fi-priority",
      stationRegistry: {
        url: "https://tie.digitraffic.fi/api/tms/v1/stations",
        format: "fintraffic-stations",
      },
    } as unknown as FeedSource;

    // Registry order: 40001 (A), 40002 (B), 40003 (C), 40004 (D), 40005 (E).
    const REGISTRY_IDS = [40001, 40002, 40003, 40004, 40005];

    function priorityStationsGeoJson(): string {
      return JSON.stringify({
        type: "FeatureCollection",
        features: REGISTRY_IDS.map((id) => ({
          type: "Feature",
          id,
          properties: {},
          geometry: { type: "Point", coordinates: [24.9, 60.2] },
        })),
      });
    }

    /** Records the station id of every sensor-constants sub-fetch, in request order. */
    function trackingFetch(seen: string[]): typeof fetch {
      return (async (url: string) => {
        const s = String(url);
        if (s.includes("sensor-constants")) {
          const stationId = s.split("/").at(-2)!;
          seen.push(stationId);
          return new Response(constants, { status: 200 });
        }
        return new Response(priorityStationsGeoJson(), { status: 200 });
      }) as unknown as typeof fetch;
    }

    it("processes uncovered stations first, then oldest-baseline stations, over the raw registry slice", async () => {
      // 40001 (A) already has an old native baseline; 40003 (C) has a newer
      // one. 40002/40004/40005 (B/D/E) have none and must win priority.
      await sql`
        INSERT INTO conditions.sensor_baseline
          (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
        VALUES
          ('fintraffic-tms-fi-priority:40001-1', ${priorityFeed.id}, -1, -1, 100, 'native', 0, '2020-01-01T00:00:00Z'),
          ('fintraffic-tms-fi-priority:40003-1', ${priorityFeed.id}, -1, -1, 100, 'native', 0, '2025-01-01T00:00:00Z')`;

      const seen: string[] = [];
      await updateFintrafficNativeBaselines(sql, priorityFeed, {
        fetch: trackingFetch(seen),
        now: () => new Date("2026-07-15T00:00:00Z"),
        batchCap: 3,
      });

      expect(seen).toEqual(["40002", "40004", "40005"]);
    }, 30_000);

    it("falls back to the raw registry-order slice when the priority query fails", async () => {
      let selectAttempts = 0;
      const throwingSql = new Proxy(sql, {
        apply(target, thisArg, args) {
          const strings = args[0] as TemplateStringsArray;
          if (strings[0]?.includes("SELECT sensor_key")) {
            selectAttempts += 1;
            throw new Error("existing-rows query failed");
          }
          return Reflect.apply(target, thisArg, args);
        },
      }) as typeof sql;

      const seen: string[] = [];
      const { updated } = await updateFintrafficNativeBaselines(throwingSql, priorityFeed, {
        fetch: trackingFetch(seen),
        now: () => new Date("2026-07-15T00:00:00Z"),
        batchCap: 3,
      });

      expect(selectAttempts).toBe(1);
      expect(seen).toEqual(["40001", "40002", "40003"]);
      expect(updated).toBeGreaterThan(0);
    }, 30_000);

    it("orders covered stations by oldest computed_at first once the batch exhausts uncovered stations", async () => {
      const coveredFeed = {
        id: "fintraffic-tms-fi-priority-covered",
        stationRegistry: {
          url: "https://tie.digitraffic.fi/api/tms/v1/stations",
          format: "fintraffic-stations",
        },
      } as unknown as FeedSource;

      // Registry order: 50001 (A), 50002 (B), 50003 (C).
      const ids = [50001, 50002, 50003];
      const geo = JSON.stringify({
        type: "FeatureCollection",
        features: ids.map((id) => ({
          type: "Feature",
          id,
          properties: {},
          geometry: { type: "Point", coordinates: [24.9, 60.2] },
        })),
      });

      // 50001 (A) and 50002 (B) already have native baselines, B older than A;
      // 50003 (C) has none and wins priority as uncovered. batchCap covers the
      // whole registry, so the batch also reaches the two covered stations,
      // and must visit the older one (B) before the newer one (A).
      await sql`
        INSERT INTO conditions.sensor_baseline
          (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
        VALUES
          ('fintraffic-tms-fi-priority-covered:50001-1', ${coveredFeed.id}, -1, -1, 100, 'native', 0, '2025-06-01T00:00:00Z'),
          ('fintraffic-tms-fi-priority-covered:50002-1', ${coveredFeed.id}, -1, -1, 100, 'native', 0, '2020-01-01T00:00:00Z')`;

      const seen: string[] = [];
      const trackingFetch = (async (url: string) => {
        const s = String(url);
        if (s.includes("sensor-constants")) {
          const stationId = s.split("/").at(-2)!;
          seen.push(stationId);
          return new Response(constants, { status: 200 });
        }
        return new Response(geo, { status: 200 });
      }) as unknown as typeof fetch;

      await updateFintrafficNativeBaselines(sql, coveredFeed, {
        fetch: trackingFetch,
        now: () => new Date("2026-07-15T00:00:00Z"),
        batchCap: 3,
      });

      expect(seen).toEqual(["50003", "50002", "50001"]);
    }, 30_000);
  });
});
