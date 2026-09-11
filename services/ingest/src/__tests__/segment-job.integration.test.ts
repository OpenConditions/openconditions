import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { runSegmentRebuild } from "../pipeline/segment-rebuild.js";
import { activateRoadGraph } from "../pipeline/graph-state.js";
import { importOsmRoads, type OsmRegion } from "../pipeline/osm-import.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";

// A single sensored region so the fake fetch below (which ignores the query
// entirely) is only ever consulted once per run.
const ONE_REGION = JSON.stringify([
  { id: "nl", bbox: [4.8, 51.9, 5.2, 52.1], tz: "Europe/Amsterdam" },
]);

// A short oneway A12 motorway way running due east along lat 52.0 — mirrors
// the fixture shape used by osm-import.test.ts / sensor-match.test.ts.
const fixture = JSON.stringify({
  elements: [
    {
      type: "way",
      id: 9,
      tags: { highway: "motorway", oneway: "yes", ref: "A12", maxspeed: "120" },
      geometry: [
        { lat: 52.0, lon: 5.0 },
        { lat: 52.0, lon: 5.1 },
      ],
    },
  ],
});
const fetchFn = (async () => new Response(fixture, { status: 200 })) as unknown as typeof fetch;

async function seedFlowSensor(): Promise<void> {
  // ~11 m north of the way, at its midpoint longitude — inside the 35 m snap gate.
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, metric, status, geom, attributes, origin,
       data_updated_at, fetched_at)
    VALUES ('flow:1', 'test-src', 'test-fmt', 'roads', 'measurement', 'flow', 'active',
      ST_SetSRID(ST_GeomFromText('POINT(5.05 52.0001)'), 4326),
      ${sql.json({ roads: "A12" })},
      ${sql.json({ kind: "feed", attribution: { provider: "test" } })},
      ${NOW}, ${NOW})`;
}

/** A closure along the fixture way, so the rebind stage has something to bind. */
async function seedClosureEvent(): Promise<void> {
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, status, geom, attributes, origin,
       data_updated_at, fetched_at)
    VALUES ('closure:1', 'test-src', 'test-fmt', 'roads', 'event', 'road_closure', 'active',
      ST_SetSRID(ST_GeomFromText('LINESTRING(5.02 52.00001, 5.08 52.00001)'), 4326),
      ${sql.json({ roads: [{ ref: "A12" }] })},
      ${sql.json({ kind: "feed", attribution: { provider: "test" } })},
      ${NOW}, ${NOW})`;
}

beforeEach(() => {
  process.env["SEGMENT_REGIONS"] = ONE_REGION;
});

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

afterEach(async () => {
  delete process.env["SEGMENT_REGIONS"];
  await sql`DELETE FROM conditions.sensor_segment`;
  await sql`DELETE FROM conditions.observations`;
  await sql`DELETE FROM conditions.road_segment`;
  await sql`DELETE FROM conditions.osm_road`;
});

describe("runSegmentRebuild", () => {
  it("runs import -> build -> encode -> match -> rebind in order and is idempotent", async () => {
    process.env["SEGMENT_REGIONS"] = ONE_REGION;
    await seedFlowSensor();
    await seedClosureEvent();

    const first = await runSegmentRebuild(sql, { fetch: fetchFn, now: () => NOW });
    expect(first).toMatchObject({ imported: 1, built: 1, encoded: 1, matched: 1, rebound: 1 });

    const [graph] = await sql<
      { generation: string; regions: Array<{ id: string }>; highway_classes: string[] }[]
    >`SELECT generation, regions, highway_classes FROM conditions.road_graph_state WHERE singleton`;
    expect(graph?.generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(graph?.regions).toEqual([
      { id: "nl", bbox: [4.8, 51.9, 5.2, 52.1], tz: "Europe/Amsterdam" },
    ]);
    expect(graph?.highway_classes).toEqual([
      "motorway",
      "motorway_link",
      "trunk",
      "trunk_link",
      "primary",
      "primary_link",
    ]);

    // The rebind stage ran against the freshly built spine, not a stale one.
    const boundRows = await sql<{ segment_id: string }[]>`
      SELECT segment_id FROM conditions.observation_segment WHERE observation_id = 'closure:1'`;
    expect(boundRows.map((r) => r.segment_id)).toEqual(["9:f"]);

    const segRows = await sql<{ segment_id: string; openlr: string | null }[]>`
      SELECT segment_id, openlr FROM conditions.road_segment`;
    expect(segRows).toHaveLength(1);
    expect(segRows[0]!.segment_id).toBe("9:f");
    expect(segRows[0]!.openlr).not.toBeNull();

    const sensorRows =
      await sql`SELECT segment_id FROM conditions.sensor_segment WHERE sensor_key = 'flow:1'`;
    expect(sensorRows).toHaveLength(1);
    expect(sensorRows[0]!.segment_id).toBe("9:f");

    // Idempotent: a second full run yields the same road_segment count and
    // keeps openlr populated (re-encode is a no-op once already encoded).
    const second = await runSegmentRebuild(sql, { fetch: fetchFn, now: () => NOW });
    expect(second.imported).toBe(1);
    expect(second.built).toBe(1);
    expect(second.matched).toBe(1);
    expect(second.rebound).toBe(1);
    const [nextGraph] = await sql<
      { generation: string }[]
    >`SELECT generation FROM conditions.road_graph_state WHERE singleton`;
    expect(nextGraph?.generation).not.toBe(graph?.generation);

    const segRowsAgain = await sql<{ segment_id: string; openlr: string | null }[]>`
      SELECT segment_id, openlr FROM conditions.road_segment`;
    expect(segRowsAgain).toHaveLength(1);
    expect(segRowsAgain[0]!.openlr).not.toBeNull();
  }, 60_000);

  it("continues to later stages when a middle stage throws", async () => {
    process.env["SEGMENT_REGIONS"] = ONE_REGION;
    await seedFlowSensor();

    // Inject a throwing encode stage in the middle; import, build, match and
    // rebind stay the real functions. A missing try/catch around any stage
    // would let this throw propagate out and reject the whole rebuild, so this
    // asserts the per-stage catch-and-continue behavior directly.
    const result = await runSegmentRebuild(sql, {
      fetch: fetchFn,
      now: () => NOW,
      steps: {
        encodeSegmentOpenlr: async () => {
          throw new Error("openlr encode blew up");
        },
      },
    });

    // The thrown stage contributes 0; every other stage still ran.
    expect(result.encoded).toBe(0);
    expect(result.imported).toBe(1);
    expect(result.built).toBe(1);
    expect(result.matched).toBe(1);

    // The later stage's effect is observable: sensor matching ran after the
    // encode stage threw and still snapped the seeded flow sensor.
    const sensorRows =
      await sql`SELECT segment_id FROM conditions.sensor_segment WHERE sensor_key = 'flow:1'`;
    expect(sensorRows).toHaveLength(1);
    expect(sensorRows[0]!.segment_id).toBe("9:f");
  }, 30_000);

  it("returns the rebuild's own counts when the rebind stage throws", async () => {
    process.env["SEGMENT_REGIONS"] = ONE_REGION;
    await seedFlowSensor();

    // The rebind is a consumer of the spine, not part of building it: a
    // resolver blow-up must not cost the rebuild the work it already did.
    const result = await runSegmentRebuild(sql, {
      fetch: fetchFn,
      now: () => NOW,
      steps: {
        rebindAll: async () => {
          throw new Error("rebind blew up");
        },
      },
    });

    expect(result).toMatchObject({ imported: 1, built: 1, encoded: 1, matched: 1, rebound: 0 });
  }, 30_000);

  it("does not activate or rebind a graph built after a partial configured-region import", async () => {
    process.env["SEGMENT_REGIONS"] = ONE_REGION;
    const [before] = await sql<{ generation: string }[]>`
      SELECT generation FROM conditions.road_graph_state WHERE singleton`;
    let rebindCalled = false;
    const result = await runSegmentRebuild(sql, {
      fetch: fetchFn,
      now: () => NOW,
      steps: {
        importOsmRoads: async () => ({ imported: 0, succeededRegions: [], failedRegions: ["nl"] }),
        buildSegments: async () => ({ built: 7 }),
        encodeSegmentOpenlr: async () => ({ encoded: 0 }),
        matchSensors: async () => ({ matched: 0 }),
        rebindAll: async () => {
          rebindCalled = true;
          return { rebound: 1, prunedSegments: 0 };
        },
      },
    });

    expect(result).toMatchObject({ imported: 0, built: 0, rebound: 0 });
    expect(rebindCalled).toBe(false);
    const [after] = await sql<{ generation: string; status: string }[]>`
      SELECT generation, status FROM conditions.road_graph_state WHERE singleton`;
    expect(after?.generation).toBe(before?.generation);
    expect(after?.status).toBe("rebuilding");
  }, 30_000);

  it("rejects old rows when a same-id region changes bbox, PBF, or highway classes", async () => {
    const original: OsmRegion = {
      id: "de",
      bbox: [5.8, 47.2, 15.1, 55.1],
      tz: "Europe/Berlin",
      pbfUrls: ["https://example.test/de-v1.osm.pbf"],
      highwayClasses: ["motorway"],
    };
    const source = {
      fetchRegion: async () => [
        {
          wayId: 44,
          coords: [
            [13.4, 52.5],
            [13.41, 52.5],
          ] as [number, number][],
          highway: "motorway",
          oneway: true,
        },
      ],
    };
    await importOsmRoads(sql, { source, now: () => NOW, regions: [original] });
    const originalEnv = { SEGMENT_REGIONS: JSON.stringify([original]) };
    await expect(activateRoadGraph(sql, { now: () => NOW, env: originalEnv })).resolves.toBeTypeOf(
      "string"
    );

    const changed: OsmRegion = {
      ...original,
      bbox: [6, 47.2, 15.1, 55.1],
      pbfUrls: ["https://example.test/de-v2.osm.pbf"],
      highwayClasses: ["motorway", "motorway_link"],
    };
    await expect(
      activateRoadGraph(sql, {
        now: () => NOW,
        env: { SEGMENT_REGIONS: JSON.stringify([changed]) },
      })
    ).rejects.toThrow(/missing current configured imports: de/);
  }, 30_000);
});

it("rejects malformed regions before any graph mutation", async () => {
  process.env["SEGMENT_REGIONS"] = JSON.stringify([
    { id: "invalid", bbox: [200, 95, 201, 96], tz: "UTC" },
  ]);
  const query = vi.fn();
  await expect(
    runSegmentRebuild(query as unknown as postgres.Sql, { fetch: fetchFn, now: () => NOW })
  ).rejects.toThrow(/SEGMENT_REGIONS/);
  expect(query).not.toHaveBeenCalled();
});

it("does not import or activate a graph without configured regions", async () => {
  delete process.env["SEGMENT_REGIONS"];
  const fetch = vi.fn();
  expect(await runSegmentRebuild(sql, { fetch, now: () => NOW })).toEqual({
    imported: 0,
    built: 0,
    encoded: 0,
    matched: 0,
    rebound: 0,
  });
  expect(fetch).not.toHaveBeenCalled();
  await expect(activateRoadGraph(sql, { now: () => NOW, env: {} })).rejects.toThrow(
    /SEGMENT_REGIONS is not configured/
  );
});
