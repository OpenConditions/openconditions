import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import {
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
      {
        way_id: string;
        highway: string;
        oneway: boolean;
        maxspeed_kph: number;
        import_config_hash: string;
        import_provenance: { region_id: string; highway_classes: string[] };
        ok: boolean;
      }[]
    >`
      SELECT way_id, highway, oneway, maxspeed_kph, import_config_hash, import_provenance,
             ST_IsValid(geom) AS ok
      FROM conditions.osm_road WHERE region = 'nl'`;
    expect(rows[0]).toMatchObject({ way_id: "9", highway: "motorway", oneway: true, ok: true });
    expect(rows[0]!.maxspeed_kph).toBe(120);
    expect(rows[0]!.import_config_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.import_provenance).toMatchObject({
      region_id: "nl",
      highway_classes: expect.arrayContaining(["motorway", "motorway_link"]),
    });
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

  const nlRegion = {
    id: "nl",
    bbox: [4.8, 51.9, 5.0, 52.1] as [number, number, number, number],
    tz: "Europe/Amsterdam",
  };
  const way = (wayId: number) => ({
    wayId,
    coords: [
      [4.9, 52.0],
      [4.91, 52.01],
    ] as [number, number][],
    highway: "motorway",
    oneway: false,
  });
  const staticSource = (ways: ReturnType<typeof way>[]) => ({ fetchRegion: async () => ways });
  const seedNl = (ids: number[]) =>
    importOsmRoads(sql, {
      source: staticSource(ids.map(way)),
      now: () => new Date().toISOString(),
      regions: [nlRegion],
    });

  it("refuses the swap and keeps the previous spine when the new count is below the threshold", async () => {
    await seedNl([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // 4 new ways < 0.9 × 10 → undercoverage guard trips; region "fails", spine kept.
    const { imported } = await importOsmRoads(sql, {
      source: staticSource([101, 102, 103, 104].map(way)),
      now: () => new Date().toISOString(),
      regions: [nlRegion],
    });
    expect(imported).toBe(0);
    const rows = await sql<
      { way_id: string }[]
    >`SELECT way_id FROM conditions.osm_road WHERE region = 'nl' ORDER BY way_id`;
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => Number(r.way_id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }, 30_000);

  it("swaps below the threshold when force is set", async () => {
    await seedNl([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { imported } = await importOsmRoads(sql, {
      source: staticSource([101, 102, 103, 104].map(way)),
      now: () => new Date().toISOString(),
      regions: [nlRegion],
      force: true,
    });
    expect(imported).toBe(4);
    const rows = await sql<
      { way_id: string }[]
    >`SELECT way_id FROM conditions.osm_road WHERE region = 'nl' ORDER BY way_id`;
    expect(rows.map((r) => Number(r.way_id))).toEqual([101, 102, 103, 104]);
  }, 30_000);

  it("imports normally on first load (no previous spine to guard)", async () => {
    const { imported } = await importOsmRoads(sql, {
      source: staticSource([1, 2, 3].map(way)),
      now: () => new Date().toISOString(),
      regions: [nlRegion],
    });
    expect(imported).toBe(3);
    const [{ count }] = await sql<
      { count: string }[]
    >`SELECT count(*) AS count FROM conditions.osm_road WHERE region = 'nl'`;
    expect(Number(count)).toBe(3);
  }, 30_000);
});

describe("loadOsmRegions", () => {
  it("does not invent coverage when SEGMENT_REGIONS is unset", () => {
    expect(loadOsmRegions({})).toEqual([]);
  });

  it("leaves graph coverage unconfigured for an empty value", () => {
    expect(loadOsmRegions({ SEGMENT_REGIONS: "" })).toEqual([]);
  });

  it("reports invalid explicit SEGMENT_REGIONS instead of claiming default coverage", () => {
    expect(() => loadOsmRegions({ SEGMENT_REGIONS: "not json" })).toThrow(
      /SEGMENT_REGIONS is invalid JSON/
    );
  });

  it("parses a SEGMENT_REGIONS JSON array override", () => {
    const custom = [{ id: "de", bbox: [5.9, 47.3, 15.0, 55.1], tz: "Europe/Berlin" }];
    const regions = loadOsmRegions({ SEGMENT_REGIONS: JSON.stringify(custom) });
    expect(regions).toEqual(custom);
  });

  it.each([
    { id: "" },
    { id: "   " },
    { id: " padded " },
    { tz: "" },
    { tz: "not-a-timezone" },
    { tz: "+01:00" },
    { tz: " Europe/Berlin " },
    { bbox: [-181, 0, 10, 20] },
    { bbox: [0, 0, 181, 20] },
    { bbox: [0, -91, 10, 20] },
    { bbox: [0, 0, 10, 91] },
    { bbox: [10, 0, 0, 20] },
    { bbox: [0, 20, 10, 0] },
    { bbox: [0, 0, 0, 20] },
    { bbox: [0, 0, 10, 0] },
    { bbox: [200, 95, 201, 96] },
  ])("rejects invalid region semantics: %j", (patch) => {
    const region = { id: "custom", bbox: [1, 2, 3, 4], tz: "UTC", ...patch };
    expect(() => loadOsmRegions({ SEGMENT_REGIONS: JSON.stringify([region]) })).toThrow(
      /SEGMENT_REGIONS/
    );
  });

  it("accepts WGS84 limits and a named timezone", () => {
    const region = { id: "world", bbox: [-180, -90, 180, 90], tz: "America/St_Johns" };
    expect(loadOsmRegions({ SEGMENT_REGIONS: JSON.stringify([region]) })).toEqual([region]);
  });

  it("accepts a region carrying valid pbfUrls", () => {
    const custom = [
      {
        id: "nl",
        bbox: [3.31, 50.75, 7.09, 53.51],
        tz: "Europe/Amsterdam",
        pbfUrls: ["https://download.geofabrik.de/europe/netherlands-latest.osm.pbf"],
      },
    ];
    expect(loadOsmRegions({ SEGMENT_REGIONS: JSON.stringify(custom) })).toEqual(custom);
  });

  it("rejects a region whose pbfUrls is empty or contains a non-string/blank", () => {
    const empty = [{ id: "nl", bbox: [1, 2, 3, 4], tz: "UTC", pbfUrls: [] }];
    const blank = [{ id: "nl", bbox: [1, 2, 3, 4], tz: "UTC", pbfUrls: [""] }];
    expect(() => loadOsmRegions({ SEGMENT_REGIONS: JSON.stringify(empty) })).toThrow(
      /contains no valid regions/
    );
    expect(() => loadOsmRegions({ SEGMENT_REGIONS: JSON.stringify(blank) })).toThrow(
      /contains no valid regions/
    );
  });

  it("accepts an explicit empty region list", () => {
    expect(loadOsmRegions({ SEGMENT_REGIONS: "[]" })).toEqual([]);
  });

  it("rejects duplicate region identities", () => {
    const region = { id: "custom", bbox: [1, 2, 3, 4], tz: "UTC" };
    expect(() => loadOsmRegions({ SEGMENT_REGIONS: JSON.stringify([region, region]) })).toThrow(
      /duplicate/
    );
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

  it("normalizes a bare-origin OVERPASS_URL to the interpreter path", () => {
    expect(overpassUrl({ OVERPASS_URL: "http://overpass" })).toBe(
      "http://overpass/api/interpreter"
    );
  });

  it("normalizes a trailing-slash OVERPASS_URL", () => {
    expect(overpassUrl({ OVERPASS_URL: "http://overpass/" })).toBe(
      "http://overpass/api/interpreter"
    );
  });
});
