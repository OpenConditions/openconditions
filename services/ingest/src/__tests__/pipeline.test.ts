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
import type { LookupFn } from "@openconditions/ingest-framework";
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

// These e2e tests inject a fake `fetch` to serve local fixtures instead of the
// real feed hosts, but `runSource` still resolves the feed host via DNS to pin
// the egress connection before calling it. Injecting a fake lookup here keeps
// the suite hermetic — it never depends on the real feed hosts' DNS being up.
const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

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
      lookup: fakeLookup,
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
      lookup: fakeLookup,
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
      lookup: fakeLookup,
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
      schedule: [
        {
          repeatFrequency: "P1D",
          startDate: "2026-06-10T06:00:00Z",
          endDate: "2026-06-10T18:00:00Z",
          scheduleTimezone: "Europe/Berlin",
        },
      ],
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
      {
        repeatFrequency: "P1D",
        startDate: "2026-06-10T06:00:00Z",
        endDate: "2026-06-10T18:00:00Z",
        scheduleTimezone: "Europe/Berlin",
      },
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

  it("diff-upserts on a second swap: unchanged row untouched, changed row updated, new row inserted, missing row deleted", async () => {
    const mkFlow = (id: string, speedKph: number, dataUpdatedAt: string): RoadFlow => ({
      id,
      source: "diffsrc",
      sourceFormat: "native",
      domain: "roads",
      kind: "measurement",
      metric: "flow",
      geometry: { type: "Point", coordinates: [6.0, 50.0] },
      los: "heavy",
      speedKph,
      aggregation: "live",
      status: "active",
      origin: { kind: "feed", attribution: { provider: "Diff", license: "CC0-1.0" } },
      dataUpdatedAt,
      fetchedAt: dataUpdatedAt,
      isStale: false,
    });

    const first = await atomicSwap(
      sql,
      "diffsrc",
      [
        mkFlow("diffsrc:unchanged", 50, "2026-06-24T11:00:00Z"),
        mkFlow("diffsrc:changed", 50, "2026-06-24T11:00:00Z"),
        mkFlow("diffsrc:removed", 50, "2026-06-24T11:00:00Z"),
      ],
      300
    );
    expect(first).toEqual({ inserted: 3, updated: 0, deleted: 0 });

    const before = await sql<{ id: string; fetched_at: Date }[]>`
      SELECT id, fetched_at FROM conditions.observations WHERE source = 'diffsrc' ORDER BY id
    `;
    const unchangedFetchedAtBefore = before.find((r) => r.id === "diffsrc:unchanged")!.fetched_at;

    const second = await atomicSwap(
      sql,
      "diffsrc",
      [
        mkFlow("diffsrc:unchanged", 50, "2026-06-24T11:00:00Z"),
        mkFlow("diffsrc:changed", 90, "2026-06-24T12:00:00Z"),
        mkFlow("diffsrc:new", 50, "2026-06-24T12:00:00Z"),
      ],
      300
    );
    expect(second).toEqual({ inserted: 1, updated: 1, deleted: 1 });

    const after = await sql<{ id: string; fetched_at: Date }[]>`
      SELECT id, fetched_at FROM conditions.observations
      WHERE source = 'diffsrc' ORDER BY id
    `;
    expect(after.map((r) => r.id)).toEqual(["diffsrc:changed", "diffsrc:new", "diffsrc:unchanged"]);

    // The unchanged row's fetched_at was never rewritten by the diff-upsert.
    const unchangedAfter = after.find((r) => r.id === "diffsrc:unchanged")!;
    expect(unchangedAfter.fetched_at.toISOString()).toBe(unchangedFetchedAtBefore.toISOString());

    // The changed row picked up its new speed and a fresh fetched_at.
    const changedAfter = after.find((r) => r.id === "diffsrc:changed")!;
    expect(changedAfter.fetched_at.toISOString()).not.toBe(unchangedFetchedAtBefore.toISOString());
  }, 30_000);

  it("collapses duplicate ids in the fresh set before chunking (last-wins), swap succeeds", async () => {
    const mkFlow = (id: string, value: number): RoadFlow => ({
      id,
      source: "dupsrc",
      sourceFormat: "native",
      domain: "roads",
      kind: "measurement",
      metric: "flow",
      geometry: { type: "Point", coordinates: [8.0, 50.0] },
      los: "heavy",
      value,
      unit: "veh/h",
      aggregation: "live",
      status: "active",
      origin: { kind: "feed", attribution: { provider: "Dup", license: "CC0-1.0" } },
      dataUpdatedAt: "2026-06-24T10:00:00Z",
      fetchedAt: "2026-06-24T10:00:00Z",
      isStale: false,
    });

    // Two observations sharing an id, differing content — the exact shape a
    // streaming parser or an `${src.id}:${externalId}` id scheme can produce
    // without cross-document dedup. Without the fix, `ON CONFLICT (id) DO
    // UPDATE` throws "command cannot affect row a second time" and the whole
    // swap rolls back.
    const counts = await atomicSwap(
      sql,
      "dupsrc",
      [mkFlow("dupsrc:1", 10), mkFlow("dupsrc:1", 20)],
      300
    );
    expect(counts).toEqual({ inserted: 1, updated: 0, deleted: 0 });

    const rows = await sql<{ id: string; value: string | null }[]>`
      SELECT id, value::text AS value FROM conditions.observations WHERE source = 'dupsrc'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe("dupsrc:1");
    expect(Number(rows[0]!.value)).toBe(20); // last one in the fresh set wins
  }, 30_000);

  it("writes the success source_status row atomically with a brand-new source's rows", async () => {
    const flow: RoadFlow = {
      id: "atomicstatus:1",
      source: "atomicstatussrc",
      sourceFormat: "native",
      domain: "roads",
      kind: "measurement",
      metric: "flow",
      geometry: { type: "Point", coordinates: [7.0, 51.0] },
      los: "heavy",
      aggregation: "live",
      status: "active",
      origin: { kind: "feed", attribution: { provider: "X", license: "CC0-1.0" } },
      dataUpdatedAt: "2026-06-24T10:00:00Z",
      fetchedAt: "2026-06-24T10:00:00Z",
      isStale: false,
    };

    // Before this fix, atomicSwap alone never touched source_status — the
    // caller had to make a second, separate call after the swap committed.
    // Calling ONLY atomicSwap here and immediately reading source_status back
    // proves the success write now lands in the same transaction as the swap.
    const counts = await atomicSwap(sql, "atomicstatussrc", [flow], 300);
    expect(counts.inserted).toBe(1);

    const status = await sql<{ last_success_at: Date | null; last_row_count: number | null }[]>`
      SELECT last_success_at, last_row_count FROM conditions.source_status
      WHERE source = 'atomicstatussrc'
    `;
    expect(status.length).toBe(1);
    expect(status[0]!.last_success_at).not.toBeNull();
    expect(status[0]!.last_row_count).toBe(1);
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
      lookup: fakeLookup,
    });

    expect(result.count).toBeGreaterThan(0);
    console.info(`[test] ndw-flow: inserted ${result.count} rows`);

    const rows = await sql<{ id: string; kind: string; source: string }[]>`
      SELECT id, kind, source
      FROM conditions.observations
      WHERE source = 'ndw-flow'
    `;

    const measurements = rows.filter((r) => r.kind === "measurement");
    // Three sites resolve (Point + LineString + the genuine standstill); the
    // rest are skipped (no-data zero/sentinel, absurd speed, missing geometry).
    expect(measurements.length).toBe(3);
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
    expect(rows.length).toBe(3);
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
      lookup: fakeLookup,
    });

    expect(result.count).toBe(0);

    const afterCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw-flow'
    `;
    expect(parseInt(afterCount[0]!.count, 10)).toBe(countBefore);
  }, 60_000);
});

describe("pipeline — parse failure", () => {
  it("swallows a parser-dispatch throw, writes source_status error, and does not advance last_success_at", async () => {
    // A feed whose format has no registered parser: `parserFor` (called from
    // inside the `buffers.flatMap(...)` dispatch, unguarded before this fix)
    // throws synchronously, before any content is actually parsed.
    const throwingFeed: DomainFeedSource = {
      ...ndwFeed,
      id: "parse-throw-src",
      format: "bogus-format",
    } as unknown as DomainFeedSource;

    const fakeFetch = async (_url: string | URL | Request): Promise<Response> => {
      return new Response("irrelevant body", { status: 200 });
    };

    const result = await runSource(throwingFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });

    expect(result.count).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/no parser registered for format/i);

    const status = await sql<{ last_error: string | null; last_success_at: Date | null }[]>`
      SELECT last_error, last_success_at FROM conditions.source_status
      WHERE source = 'parse-throw-src'
    `;
    expect(status.length).toBe(1);
    expect(status[0]!.last_error).toMatch(/no parser registered for format/i);
    expect(status[0]!.last_success_at).toBeNull();
  }, 30_000);
});

describe("pipeline — streaming SAX parse failure preserves last-good rows", () => {
  const sitePayload = readFileSync(NDW_FLOW_SITE_TABLE_FIXTURE_PATH);
  const speedPayload = readFileSync(NDW_FLOW_SPEED_FIXTURE_PATH);

  it("parse-failure-preserves-last-good: a truncated document sets failed:true, skips the swap, and does not advance last_success_at", async () => {
    // Establish a known-good baseline for this source first, independent of
    // whatever earlier describe blocks in this file left behind.
    clearSiteTableCache();
    const goodFetch = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = href.includes("measurement.xml.gz") ? sitePayload : speedPayload;
      return new Response(gzipSync(body), { status: 200 });
    };
    const goodResult = await runSource(ndwFlowFeed, {
      sql,
      fetch: goodFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    // `count` reflects rows the diff-upsert actually touched this cycle, which
    // can legitimately be 0 if content is byte-identical to an earlier run in
    // this file (an unchanged row is left untouched) — the real assertion is
    // "no failure" plus the row-count check just below.
    expect(goodResult.error).toBeUndefined();

    const before = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw-flow'
    `;
    const countBefore = parseInt(before[0]!.count, 10);
    expect(countBefore).toBeGreaterThan(0);

    const statusBefore = await sql<{ last_success_at: Date | null }[]>`
      SELECT last_success_at FROM conditions.source_status WHERE source = 'ndw-flow'
    `;
    const lastSuccessAtBefore = statusBefore[0]!.last_success_at;
    expect(lastSuccessAtBefore).not.toBeNull();

    // Site table still resolves fine; the measurement document itself is
    // truncated mid-element — the same kind of mid-document glitch a ~50 MB
    // feed can suffer, which the SAX parser's internal `failed` flag catches.
    clearSiteTableCache();
    const truncatedSpeedXml = speedPayload
      .toString("utf8")
      .slice(0, Math.floor(speedPayload.length * 0.6));
    const brokenFetch = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = href.includes("measurement.xml.gz")
        ? gzipSync(sitePayload)
        : gzipSync(Buffer.from(truncatedSpeedXml, "utf8"));
      return new Response(body, { status: 200 });
    };

    const result = await runSource(ndwFlowFeed, {
      sql,
      fetch: brokenFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });

    expect(result.count).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/streaming parse failed/i);

    const after = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw-flow'
    `;
    expect(parseInt(after[0]!.count, 10)).toBe(countBefore);

    const statusAfter = await sql<{ last_error: string | null; last_success_at: Date | null }[]>`
      SELECT last_error, last_success_at FROM conditions.source_status WHERE source = 'ndw-flow'
    `;
    expect(statusAfter[0]!.last_error).toMatch(/streaming parse failed/i);
    expect(statusAfter[0]!.last_success_at?.toISOString()).toBe(lastSuccessAtBefore!.toISOString());
  }, 60_000);
});

describe("pipeline — flow feed 200-with-garbage (well-formed empty publication)", () => {
  const sitePayload = readFileSync(NDW_FLOW_SITE_TABLE_FIXTURE_PATH);
  const speedPayload = readFileSync(NDW_FLOW_SPEED_FIXTURE_PATH);

  it("200-with-garbage (flow): a body that parses to zero measurements skips the swap; rows survive", async () => {
    // Establish a known-good baseline for this source first, independent of
    // whatever earlier describe blocks in this file left behind (mirrors the
    // SAX-failure test above).
    clearSiteTableCache();
    const goodFetch = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = href.includes("measurement.xml.gz") ? sitePayload : speedPayload;
      return new Response(gzipSync(body), { status: 200 });
    };
    const goodResult = await runSource(ndwFlowFeed, {
      sql,
      fetch: goodFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(goodResult.error).toBeUndefined();

    const before = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw-flow'
    `;
    const countBefore = parseInt(before[0]!.count, 10);
    expect(countBefore).toBeGreaterThan(0);

    clearSiteTableCache();
    // A 200 response whose body is well-formed XML and DOES contain a
    // `siteMeasurements` element (so the streaming parser's `failed` flag is
    // NOT set — the parser saw the expected publication), but the site carries
    // no resolvable geometry — indistinguishable from "garbage" at the HTTP
    // layer, and yields zero flows. The flow-feed shrink guard ("a sensor
    // network never legitimately vanishes to zero") is what must catch this,
    // independent of the `failed` flag (that flag's own hard-failure case —
    // no publication found at all — is covered by the SAX-failure describe
    // block above).
    const garbageFetch = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = href.includes("measurement.xml.gz")
        ? gzipSync(sitePayload)
        : gzipSync(Buffer.from("<D2LogicalModel><siteMeasurements/></D2LogicalModel>"));
      return new Response(body, { status: 200 });
    };

    const result = await runSource(ndwFlowFeed, {
      sql,
      fetch: garbageFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });

    expect(result.count).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/zero measurements/i);

    const after = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw-flow'
    `;
    expect(parseInt(after[0]!.count, 10)).toBe(countBefore);
  }, 60_000);
});

describe("pipeline — shrink tripwire (event feed)", () => {
  const shrinkFeed: DomainFeedSource = { ...drivebcFeed, id: "shrink-test-src" };
  const emptyEventsFetch = async (_url: string | URL | Request): Promise<Response> => {
    return new Response(JSON.stringify({ events: [] }), { status: 200 });
  };

  it("shrink tripwire (events): seeds N rows, then a well-formed empty response is written as-is only once allowMassClear is set", async () => {
    // Seed N rows for this source from the real DriveBC fixture.
    const jsonPayload = readFileSync(DRIVEBC_FIXTURE_PATH);
    const seedFetch = async (_url: string | URL | Request): Promise<Response> => {
      return new Response(jsonPayload, { status: 200 });
    };
    const seedResult = await runSource(shrinkFeed, {
      sql,
      fetch: seedFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(seedResult.count).toBeGreaterThan(0);
    const seededCount = seedResult.count;

    const status = await sql<{ last_row_count: number | null }[]>`
      SELECT last_row_count FROM conditions.source_status WHERE source = 'shrink-test-src'
    `;
    expect(status[0]!.last_row_count).toBe(seededCount);

    // allowMassClear defaults to false: a fresh count of 0 against a nonzero
    // previous count must skip the swap and preserve the seeded rows.
    const guarded = await runSource(shrinkFeed, {
      sql,
      fetch: emptyEventsFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(guarded.count).toBe(0);
    expect(guarded.error).toBeDefined();
    expect(guarded.error).toMatch(/shrank/i);

    const afterGuarded = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'shrink-test-src'
    `;
    expect(parseInt(afterGuarded[0]!.count, 10)).toBe(seededCount);

    // The error write must not have clobbered last_row_count (needed so the
    // tripwire's baseline survives an error cycle).
    const statusAfterGuarded = await sql<{ last_row_count: number | null }[]>`
      SELECT last_row_count FROM conditions.source_status WHERE source = 'shrink-test-src'
    `;
    expect(statusAfterGuarded[0]!.last_row_count).toBe(seededCount);

    // allowMassClear:true opts this feed out of the tripwire — the same empty
    // response now legitimately clears the source's rows.
    const massClearFeed: DomainFeedSource = { ...shrinkFeed, allowMassClear: true };
    const cleared = await runSource(massClearFeed, {
      sql,
      fetch: emptyEventsFetch as typeof fetch,
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(cleared.error).toBeUndefined();

    const afterCleared = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'shrink-test-src'
    `;
    expect(parseInt(afterCleared[0]!.count, 10)).toBe(0);
  }, 30_000);
});

describe("pipeline — fan-out partial-failure threshold", () => {
  /** Minimal well-formed open511 event, unique per url so each sub-feed's
   * contribution is distinguishable in the observations table. */
  function eventBodyFor(url: string): string {
    return JSON.stringify({
      events: [
        {
          id: url,
          event_type: "CONSTRUCTION",
          geography: { type: "Point", coordinates: [0, 0] },
        },
      ],
    });
  }

  function fanoutFetchFor(failUrls: Set<string>): typeof fetch {
    return (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (failUrls.has(url)) return new Response("err", { status: 500 });
      return new Response(eventBodyFor(url), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("skips the swap when the fan-out failure ratio is at/above the default threshold (0.5), preserving last-good rows", async () => {
    const urls = Array.from({ length: 4 }, (_, i) => `https://fanout-skip.test/${i}`);
    const feed: DomainFeedSource = {
      ...drivebcFeed,
      id: "fanout-skip-test-src",
      url: urls,
      fanoutTolerant: true,
    };

    const seeded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set()),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(seeded.error).toBeUndefined();
    expect(seeded.count).toBe(4);

    // 3 of 4 sub-feeds fail this cycle (ratio 0.75 >= the 0.5 default) — the
    // swap must be skipped entirely rather than reconciling against the
    // surviving 1-of-4 fragment, which would otherwise delete the 3 rows
    // belonging to the failed sub-feeds as "missing".
    const guarded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set(urls.slice(1))),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(guarded.count).toBe(0);
    expect(guarded.error).toBeDefined();
    expect(guarded.error).toMatch(/fan-out/i);

    const after = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'fanout-skip-test-src'
    `;
    expect(parseInt(after[0]!.count, 10)).toBe(4);
  }, 30_000);

  it("skips the swap at the EXACT threshold boundary (2 of 4 fail = ratio 0.5, >= semantics)", async () => {
    const urls = Array.from({ length: 4 }, (_, i) => `https://fanout-boundary.test/${i}`);
    const feed: DomainFeedSource = {
      ...drivebcFeed,
      id: "fanout-boundary-test-src",
      url: urls,
      fanoutTolerant: true,
    };

    const seeded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set()),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(seeded.error).toBeUndefined();
    expect(seeded.count).toBe(4);

    // Exactly half the sub-feeds fail (ratio 0.5 === the 0.5 default): the
    // guard's `>=` must treat the boundary as skip, not proceed.
    const guarded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set(urls.slice(0, 2))),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(guarded.count).toBe(0);
    expect(guarded.error).toBeDefined();
    expect(guarded.error).toMatch(/fan-out/i);

    const after = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'fanout-boundary-test-src'
    `;
    expect(parseInt(after[0]!.count, 10)).toBe(4);
  }, 30_000);

  it("proceeds with the swap when the fan-out failure ratio is below the default threshold", async () => {
    const urls = Array.from({ length: 4 }, (_, i) => `https://fanout-proceed.test/${i}`);
    const feed: DomainFeedSource = {
      ...drivebcFeed,
      id: "fanout-proceed-test-src",
      url: urls,
      fanoutTolerant: true,
    };

    const seeded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set()),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(seeded.error).toBeUndefined();
    expect(seeded.count).toBe(4);

    // Only 1 of 4 sub-feeds fails this cycle (ratio 0.25 < the 0.5 default) —
    // below threshold the swap proceeds as normal, accepting that the failed
    // sub-feed's row is pruned as "missing" this cycle (the named trade-off).
    const proceeded = await runSource(feed, {
      sql,
      fetch: fanoutFetchFor(new Set([urls[0]!])),
      now: () => new Date().toISOString(),
      lookup: fakeLookup,
    });
    expect(proceeded.error).toBeUndefined();
    expect(proceeded.count).toBe(3);

    const after = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'fanout-proceed-test-src'
    `;
    expect(parseInt(after[0]!.count, 10)).toBe(3);
  }, 30_000);
});
