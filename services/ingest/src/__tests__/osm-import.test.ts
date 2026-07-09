import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import {
  DEFAULT_OSM_REGIONS,
  importOsmRoads,
  loadOsmRegions,
  overpassSource,
  overpassUrl,
} from "../pipeline/osm-import.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const fixture = JSON.stringify({
  elements: [
    {
      type: "way",
      id: 9,
      tags: { highway: "motorway", oneway: "yes", ref: "A1", maxspeed: "120" },
      geometry: [
        { lat: 52, lon: 4.9 },
        { lat: 52.02, lon: 4.95 },
      ],
    },
  ],
});
const fetchFn = (async () => new Response(fixture, { status: 200 })) as unknown as typeof fetch;

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
  await sql`DELETE FROM conditions.osm_road`;
  delete process.env["SEGMENT_REGIONS"];
});

describe("importOsmRoads", () => {
  it("imports ways into osm_road with valid geometry", async () => {
    const { imported } = await importOsmRoads(sql, {
      source: overpassSource(fetchFn),
      now: () => new Date().toISOString(),
      regions: [{ id: "nl", bbox: [4.8, 51.9, 5.0, 52.1], tz: "Europe/Amsterdam" }],
    });
    expect(imported).toBe(1);
    const rows = await sql<
      { way_id: string; highway: string; oneway: boolean; maxspeed_kph: number; ok: boolean }[]
    >`
      SELECT way_id, highway, oneway, maxspeed_kph, ST_IsValid(geom) AS ok
      FROM conditions.osm_road WHERE region = 'nl'`;
    expect(rows[0]).toMatchObject({ way_id: "9", highway: "motorway", oneway: true, ok: true });
    expect(rows[0]!.maxspeed_kph).toBe(120);
  }, 30_000);

  it("re-imports an overlapping border way into a second region without a PK error", async () => {
    await importOsmRoads(sql, {
      source: overpassSource(fetchFn),
      now: () => new Date().toISOString(),
      regions: [{ id: "nl", bbox: [4.8, 51.9, 5.0, 52.1], tz: "Europe/Amsterdam" }],
    });

    const { imported } = await importOsmRoads(sql, {
      source: overpassSource(fetchFn),
      now: () => new Date().toISOString(),
      regions: [{ id: "se", bbox: [4.8, 51.9, 5.0, 52.1], tz: "Europe/Stockholm" }],
    });

    expect(imported).toBe(1);
    const rows = await sql<{ way_id: string; region: string }[]>`
      SELECT way_id, region FROM conditions.osm_road WHERE way_id = 9`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.region).toBe("se");
  }, 30_000);

  it("tolerates a per-region fetch failure without wiping other regions", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("overpass down");
      return new Response(fixture, { status: 200 });
    }) as unknown as typeof fetch;

    const { imported } = await importOsmRoads(sql, {
      source: overpassSource(flaky),
      now: () => new Date().toISOString(),
      regions: [
        { id: "fi", bbox: [20.6, 59.8, 31.6, 70.1], tz: "Europe/Helsinki" },
        { id: "nl", bbox: [4.8, 51.9, 5.0, 52.1], tz: "Europe/Amsterdam" },
      ],
    });

    expect(imported).toBe(1);
    const rows = await sql<{ region: string }[]>`
      SELECT region FROM conditions.osm_road WHERE way_id = 9`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.region).toBe("nl");
  }, 30_000);
});

describe("loadOsmRegions", () => {
  it("falls back to DEFAULT_OSM_REGIONS when SEGMENT_REGIONS is unset", () => {
    expect(loadOsmRegions({})).toEqual(DEFAULT_OSM_REGIONS);
  });

  it("falls back to DEFAULT_OSM_REGIONS on an empty SEGMENT_REGIONS value", () => {
    expect(loadOsmRegions({ SEGMENT_REGIONS: "" })).toEqual(DEFAULT_OSM_REGIONS);
  });

  it("falls back to DEFAULT_OSM_REGIONS on unparseable SEGMENT_REGIONS JSON", () => {
    expect(loadOsmRegions({ SEGMENT_REGIONS: "not json" })).toEqual(DEFAULT_OSM_REGIONS);
  });

  it("parses a SEGMENT_REGIONS JSON array override", () => {
    const custom = [{ id: "de", bbox: [5.9, 47.3, 15.0, 55.1], tz: "Europe/Berlin" }];
    const regions = loadOsmRegions({ SEGMENT_REGIONS: JSON.stringify(custom) });
    expect(regions).toEqual(custom);
  });
});

describe("overpassUrl", () => {
  it("falls back to the public instance when OVERPASS_URL is unset", () => {
    expect(overpassUrl({})).toBe("https://overpass-api.de/api/interpreter");
  });

  it("falls back to the public instance on an empty OVERPASS_URL value", () => {
    expect(overpassUrl({ OVERPASS_URL: "" })).toBe("https://overpass-api.de/api/interpreter");
  });

  it("uses a configured OVERPASS_URL override", () => {
    expect(overpassUrl({ OVERPASS_URL: "http://overpass/api/interpreter" })).toBe(
      "http://overpass/api/interpreter"
    );
  });
});
