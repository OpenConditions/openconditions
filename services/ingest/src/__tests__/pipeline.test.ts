import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { readObservations, runMigrations } from "@openconditions/core";
import { FEED_SOURCES } from "@openconditions/roads";
import type { RoadEvent, RoadFlow } from "@openconditions/roads";
import { atomicSwap } from "../pipeline/write-postgis.js";
import { runSource } from "../pipeline/run.js";
import type { DomainFeedSource } from "../pipeline/run.js";

const NDW_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/ndw/actueel_beeld.xml"
);

const DRIVEBC_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/drivebc/events.json"
);

const ndwFeed: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "ndw")!,
  domain: "roads",
};

const drivebcFeed: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "drivebc")!,
  domain: "roads",
};

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

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

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://oc:oc@${host}:${port}/conditions_test`;
  sql = postgres(url, { max: 3 });

  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("pipeline — happy path", () => {
  it("inserts rows from the NDW fixture into conditions.observations", async () => {
    const xmlPayload = readFileSync(NDW_FIXTURE_PATH);

    const fakeFetch = async (_url: string | URL | Request): Promise<Response> => {
      return new Response(xmlPayload, { status: 200 });
    };

    const result = await runSource(ndwFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      now: () => new Date().toISOString(),
    });

    expect(result.count).toBeGreaterThan(0);
    console.info(`[test] inserted ${result.count} rows`);

    const wrongRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.observations
      WHERE domain <> 'roads' OR source <> 'ndw'
    `;
    expect(parseInt(wrongRows[0]!.count, 10)).toBe(0);
  }, 60_000);

  it("all inserted geometries are valid PostGIS geometries", async () => {
    const invalid = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.observations
      WHERE NOT ST_IsValid(geom)
    `;
    expect(parseInt(invalid[0]!.count, 10)).toBe(0);
  }, 30_000);

  it("at least one row has road-specific attributes (isPlanned present)", async () => {
    const rows = await sql<{ attributes: unknown }[]>`
      SELECT attributes
      FROM conditions.observations
      WHERE domain = 'roads'
      LIMIT 100
    `;
    const hasRoadAttrs = rows.some((r) => {
      const attrs = r.attributes as Record<string, unknown> | null;
      return attrs != null && "isPlanned" in attrs;
    });
    expect(hasRoadAttrs).toBe(true);
  }, 30_000);
});

describe("pipeline — feed downtime", () => {
  it("leaves existing rows intact when fetch throws", async () => {
    const beforeCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw'
    `;
    const countBefore = parseInt(beforeCount[0]!.count, 10);
    expect(countBefore).toBeGreaterThan(0);

    const throwingFetch = async (_url: string | URL | Request): Promise<Response> => {
      throw new Error("simulated network failure");
    };

    const result = await runSource(ndwFeed, {
      sql,
      fetch: throwingFetch as typeof fetch,
      now: () => new Date().toISOString(),
    });

    expect(result.count).toBe(0);

    const afterCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw'
    `;
    const countAfter = parseInt(afterCount[0]!.count, 10);
    expect(countAfter).toBe(countBefore);
  }, 30_000);
});

describe("pipeline — open511 (DriveBC)", () => {
  it("inserts rows from the DriveBC fixture with source='drivebc' and domain='roads'", async () => {
    const jsonPayload = readFileSync(DRIVEBC_FIXTURE_PATH);

    const fakeFetch = async (_url: string | URL | Request): Promise<Response> => {
      return new Response(jsonPayload, { status: 200 });
    };

    const result = await runSource(drivebcFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      now: () => new Date().toISOString(),
    });

    expect(result.count).toBeGreaterThan(0);
    console.info(`[test] drivebc: inserted ${result.count} rows`);

    const wrongRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.observations
      WHERE source = 'drivebc' AND (domain <> 'roads')
    `;
    expect(parseInt(wrongRows[0]!.count, 10)).toBe(0);
  }, 60_000);

  it("all DriveBC geometries are valid PostGIS geometries", async () => {
    const invalid = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.observations
      WHERE source = 'drivebc' AND NOT ST_IsValid(geom)
    `;
    expect(parseInt(invalid[0]!.count, 10)).toBe(0);
  }, 30_000);
});

describe("store round-trip — typed columns + attributes JSONB", () => {
  it("persists label (column) and road-specific fields (attributes) and reads them back", async () => {
    const ev: RoadEvent = {
      id: "rt:1",
      source: "rt",
      sourceFormat: "wzdx",
      domain: "roads",
      kind: "event",
      type: "roadworks",
      category: "planned",
      isPlanned: true,
      severity: "low",
      severitySource: "derived",
      headline: "Roadworks",
      label: "Big Dig",
      geometry: { type: "Point", coordinates: [13.4, 52.5] },
      status: "active",
      roads: [{ name: "A2" }],
      roadState: "some_lanes_closed",
      workersPresent: true,
      workZoneType: "moving",
      speedLimitKph: 50,
      regions: ["Berlin"],
      origin: { kind: "feed", attribution: { provider: "X", license: "CC0-1.0" } },
      dataUpdatedAt: "2026-06-23T10:00:00Z",
      fetchedAt: "2026-06-23T10:00:00Z",
      isStale: false,
    };
    await atomicSwap(sql, "rt", [ev]);

    const db = {
      async execute<T = unknown>(q: string, p?: unknown[]): Promise<T> {
        return (p ? await sql.unsafe(q, p as never[]) : await sql.unsafe(q)) as T;
      },
    };
    const out = await readObservations(db, { domain: "roads", bbox: [13, 52, 14, 53] });
    const got = out.find((o) => o.id === "rt:1") as RoadEvent | undefined;
    expect(got).toBeDefined();
    expect(got!.label).toBe("Big Dig"); // dedicated column
    expect(got!.roadState).toBe("some_lanes_closed"); // attributes JSONB
    expect(got!.workersPresent).toBe(true);
    expect(got!.workZoneType).toBe("moving");
    expect(got!.speedLimitKph).toBe(50);
    expect(got!.regions).toEqual(["Berlin"]);
  }, 30_000);

  it("persists a RoadFlow measurement (metric/value columns + flow attributes)", async () => {
    const flow: RoadFlow = {
      id: "flow:1",
      source: "rtflow",
      sourceFormat: "native",
      domain: "roads",
      kind: "measurement",
      metric: "flow",
      geometry: {
        type: "LineString",
        coordinates: [
          [13.4, 52.5],
          [13.5, 52.6],
        ],
      },
      los: "heavy",
      speedKph: 40,
      freeFlowKph: 100,
      speedRatio: 0.4,
      delaySeconds: 120,
      jamFactor: 6,
      value: 1200,
      unit: "veh/h",
      aggregation: "live",
      status: "active",
      origin: { kind: "feed", attribution: { provider: "X", license: "CC0-1.0" } },
      dataUpdatedAt: "2026-06-23T10:00:00Z",
      fetchedAt: "2026-06-23T10:00:00Z",
      isStale: false,
    };
    await atomicSwap(sql, "rtflow", [flow]);

    const db = {
      async execute<T = unknown>(q: string, p?: unknown[]): Promise<T> {
        return (p ? await sql.unsafe(q, p as never[]) : await sql.unsafe(q)) as T;
      },
    };
    const out = await readObservations(db, { domain: "roads", bbox: [13, 52, 14, 53] });
    const got = out.find((o) => o.id === "flow:1") as RoadFlow | undefined;
    expect(got).toBeDefined();
    expect(got!.kind).toBe("measurement");
    expect(got!.metric).toBe("flow"); // typed columns
    expect(got!.value).toBe(1200);
    expect(got!.unit).toBe("veh/h");
    expect(got!.aggregation).toBe("live");
    expect(got!.los).toBe("heavy"); // attributes JSONB
    expect(got!.speedKph).toBe(40);
    expect(got!.delaySeconds).toBe(120);
  }, 30_000);
});
