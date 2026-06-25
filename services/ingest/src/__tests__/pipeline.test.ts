import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { readObservations } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { FEED_SOURCES } from "@openconditions/roads";
import type { RoadEvent, RoadFlow } from "@openconditions/roads";
import { atomicSwap } from "../pipeline/write-postgis.js";
import { runSource } from "../pipeline/run.js";
import type { DomainFeedSource } from "../pipeline/run.js";
import { clearSiteTableCache } from "../pipeline/site-table.js";

const NDW_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/ndw/actueel_beeld.xml"
);

const DRIVEBC_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/drivebc/events.json"
);

const NDW_FLOW_SPEED_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/ndw-flow/trafficspeed.xml"
);

const NDW_FLOW_SITE_TABLE_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/ndw-flow/measurement_site_table.xml"
);

const ndwFeed: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "ndw")!,
  domain: "roads",
};

const drivebcFeed: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "drivebc")!,
  domain: "roads",
};

const ndwFlowFeed: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "ndw-flow")!,
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
      detourGeometry: {
        type: "LineString",
        coordinates: [
          [13.4, 52.5],
          [13.42, 52.51],
        ],
      },
      schedule: [{ dateStart: "2026-06-10T06:00:00Z", dateEnd: "2026-06-10T18:00:00Z" }],
      externalRefs: { external: { system: "RIS-index", code: "NL123" } },
      confidence: "likely",
      isForecast: true,
      relatedIds: ["parent-1", "parent-2"],
      sourceRaw: { provider_field: "verbatim" },
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
    expect(got!.detourGeometry).toEqual({
      type: "LineString",
      coordinates: [
        [13.4, 52.5],
        [13.42, 52.51],
      ],
    });
    expect(got!.schedule).toEqual([
      { dateStart: "2026-06-10T06:00:00Z", dateEnd: "2026-06-10T18:00:00Z" },
    ]);
    expect(got!.externalRefs?.external).toEqual({ system: "RIS-index", code: "NL123" });
    expect(got!.confidence).toBe("likely"); // typed column, was dropped on read
    expect(got!.isForecast).toBe(true);
    expect(got!.relatedIds).toEqual(["parent-1", "parent-2"]);
    expect(got!.source).toBe("rt"); // feed id NOT clobbered by sourceRaw
    expect(got!.sourceRaw).toEqual({ provider_field: "verbatim" }); // verbatim passthrough survives
  }, 30_000);

  it("persists a RoadFlow measurement (metric/value columns + flow attributes)", async () => {
    // NOTE: this is just the direct atomicSwap round-trip; the full flow-feed
    // e2e test (parseFor dispatch → DB) lives in the "flow feed — e2e pipeline"
    // suite below.
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

describe("atomicSwap — bulk insert at volume", () => {
  it("inserts many rows correctly across chunk boundaries", async () => {
    const COUNT = 1500; // spans multiple insert chunks
    const flows: RoadFlow[] = Array.from({ length: COUNT }, (_, i) => ({
      id: `bulk:${i}`,
      source: "bulk",
      sourceFormat: "native",
      domain: "roads",
      kind: "measurement",
      metric: "flow",
      geometry: { type: "Point", coordinates: [4.0 + i * 1e-4, 52.0] },
      los: i % 2 === 0 ? "free_flow" : "heavy",
      speedKph: 30 + (i % 70),
      value: 30 + (i % 70),
      unit: "km/h",
      aggregation: "live",
      status: "active",
      origin: { kind: "feed", attribution: { provider: "Bulk", license: "CC0-1.0" } },
      dataUpdatedAt: "2026-06-24T10:00:00Z",
      fetchedAt: "2026-06-24T10:00:00Z",
      isStale: false,
    }));

    await atomicSwap(sql, "bulk", flows, 300);

    const counted = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'bulk'
    `;
    expect(parseInt(counted[0]!.count, 10)).toBe(COUNT);

    // Typed columns, JSONB attributes, geometry and the derived stale_after all
    // survive the bulk path for a spot-checked row.
    const one = await sql<
      {
        metric: string | null;
        value: string | null;
        gtype: string;
        los: unknown;
        stale: string | null;
      }[]
    >`
      SELECT metric, value::text AS value, ST_GeometryType(geom) AS gtype,
             attributes->>'los' AS los, stale_after::text AS stale
      FROM conditions.observations WHERE id = 'bulk:1000'
    `;
    expect(one.length).toBe(1);
    expect(one[0]!.metric).toBe("flow");
    expect(Number(one[0]!.value)).toBe(30 + (1000 % 70));
    expect(one[0]!.gtype).toBe("ST_Point");
    expect(one[0]!.los).toBe("free_flow");
    expect(one[0]!.stale).not.toBeNull();

    const invalid = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations
      WHERE source = 'bulk' AND NOT ST_IsValid(geom)
    `;
    expect(parseInt(invalid[0]!.count, 10)).toBe(0);
  }, 60_000);

  it("replaces the row set on a second swap (delete-all + insert)", async () => {
    const flows: RoadFlow[] = [
      {
        id: "bulk:new",
        source: "bulk",
        sourceFormat: "native",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        geometry: { type: "Point", coordinates: [5.0, 52.0] },
        los: "heavy",
        aggregation: "live",
        status: "active",
        origin: { kind: "feed", attribution: { provider: "Bulk", license: "CC0-1.0" } },
        dataUpdatedAt: "2026-06-24T11:00:00Z",
        fetchedAt: "2026-06-24T11:00:00Z",
        isStale: false,
      },
    ];
    await atomicSwap(sql, "bulk", flows, 300);

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM conditions.observations WHERE source = 'bulk'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe("bulk:new");
  }, 30_000);
});

describe("flow feed — e2e pipeline (NDW site-table join)", () => {
  // A fetch stub that serves the trafficspeed measurements for the data URL and
  // the site table for the companion site-table URL, gzipping both since the
  // feed declares gzip. The site-table cache is cleared first so the stub is hit.
  const speedPayload = readFileSync(NDW_FLOW_SPEED_FIXTURE_PATH);
  const sitePayload = readFileSync(NDW_FLOW_SITE_TABLE_FIXTURE_PATH);

  const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const body = href.includes("measurement.xml.gz")
      ? gzipSync(sitePayload)
      : gzipSync(speedPayload);
    return new Response(body, { status: 200 });
  };

  it("runSource joins the site table and writes RoadFlow measurements with real geometry", async () => {
    clearSiteTableCache();

    const result = await runSource(ndwFlowFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      now: () => new Date().toISOString(),
    });

    expect(result.count).toBeGreaterThan(0);
    console.info(`[test] ndw-flow: inserted ${result.count} rows`);

    const rows = await sql<{ id: string; kind: string; source: string }[]>`
      SELECT id, kind, source
      FROM conditions.observations
      WHERE source = 'ndw-flow'
    `;

    const measurements = rows.filter((r) => r.kind === "measurement");
    // Two sites resolve (Point + LineString); two are skipped (no-data, missing).
    expect(measurements.length).toBe(2);
    // los is unknown for NDW (no baseline), so no derived congestion events.
    const events = rows.filter((r) => r.kind === "event");
    expect(events.length).toBe(0);
  }, 60_000);

  it("flow rows use 'roads' domain and 'ndw-flow' source", async () => {
    const wrongRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.observations
      WHERE source = 'ndw-flow' AND (domain <> 'roads')
    `;
    expect(parseInt(wrongRows[0]!.count, 10)).toBe(0);
  }, 30_000);

  it("all flow geometries are valid PostGIS geometries", async () => {
    const invalid = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.observations
      WHERE source = 'ndw-flow' AND NOT ST_IsValid(geom)
    `;
    expect(parseInt(invalid[0]!.count, 10)).toBe(0);
  }, 30_000);

  it("writes a real Point geometry resolved from the site table", async () => {
    const rows = await sql<{ gtype: string; lon: number; lat: number }[]>`
      SELECT ST_GeometryType(geom) AS gtype, ST_X(geom) AS lon, ST_Y(geom) AS lat
      FROM conditions.observations
      WHERE id = 'ndw-flow:PZH01_MST_0065_00'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.gtype).toBe("ST_Point");
    expect(rows[0]!.lon).toBeCloseTo(4.536069, 5);
    expect(rows[0]!.lat).toBeCloseTo(52.0235558, 5);
  }, 30_000);

  it("flow measurements have metric='flow' and the live speed value", async () => {
    const rows = await sql<{ metric: string | null; value: string | null }[]>`
      SELECT metric, value::text AS value
      FROM conditions.observations
      WHERE source = 'ndw-flow' AND kind = 'measurement'
    `;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.metric === "flow")).toBe(true);
    const best = rows.find((r) => r.value != null && Number(r.value) === 64);
    expect(best).toBeDefined();
  }, 30_000);

  it("preserves last-good rows on a cold site-table failure (no atomicSwap to empty)", async () => {
    // Existing ndw-flow rows from the successful runs above.
    const beforeCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw-flow'
    `;
    const countBefore = parseInt(beforeCount[0]!.count, 10);
    expect(countBefore).toBeGreaterThan(0);

    // Clear the cache so there is NO cached site map — the failure is cold.
    clearSiteTableCache();

    // Measurements still fetch fine, but the site table fails outright. Without
    // the cold-failure guard this would parse measurements with no geometry,
    // yield [], and atomicSwap an empty set — deleting all ndw-flow rows.
    const partialFetch = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("measurement.xml.gz")) {
        return new Response("nope", { status: 503 });
      }
      return new Response(gzipSync(speedPayload), { status: 200 });
    };

    const result = await runSource(ndwFlowFeed, {
      sql,
      fetch: partialFetch as typeof fetch,
      now: () => new Date().toISOString(),
    });

    expect(result.count).toBe(0);

    const afterCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw-flow'
    `;
    expect(parseInt(afterCount[0]!.count, 10)).toBe(countBefore);
  }, 60_000);
});
