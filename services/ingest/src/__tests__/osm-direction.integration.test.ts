import { createHash } from "node:crypto";
import { decodeOpenLrBinary } from "@openconditions/openlr";
import { parseOsmiumGeojsonSeq, parseOverpassWays } from "@openconditions/roads";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activateRoadGraph, beginRoadGraphRebuild } from "../pipeline/graph-state.js";
import {
  importOsmRoads,
  type OsmRegion,
  osmRegionImportProvenance,
} from "../pipeline/osm-import.js";
import { buildSegments } from "../pipeline/segment-build.js";
import { encodeSegmentOpenlr } from "../pipeline/segment-openlr.js";
import { runSegmentRebuild } from "../pipeline/segment-rebuild.js";
import { seedFlowSource, siteKey, writeSiteReadings } from "./helpers/flow-series.js";
import { situationDraft, writeSituations } from "./helpers/situations.js";

const NOW = "2026-09-06T10:00:00Z";
const REGION: OsmRegion = { id: "nl", bbox: [4.9, 51.9, 5.2, 52.1], tz: "Europe/Amsterdam" };
const COORDS: [number, number][] = [
  [5, 52],
  [5.05, 52],
  [5.1, 52],
];
type Tag = string | undefined;
type Representation = "overpass" | "osmium";
let db: TestDatabase;
let sql: postgres.Sql;

function overpassBody(tags: Tag[]): string {
  return JSON.stringify({
    elements: tags.map((oneway, i) => ({
      type: "way",
      id: 100 + i,
      tags: { highway: "primary", ref: "N44", oneway },
      geometry: COORDS.map(([lon, lat]) => ({ lon, lat })),
    })),
  });
}
function waysFrom(representation: Representation, tags: Tag[]) {
  if (representation === "overpass") return parseOverpassWays(overpassBody(tags));
  return parseOsmiumGeojsonSeq(
    tags
      .map((oneway, i) =>
        JSON.stringify({
          type: "Feature",
          id: `w${100 + i}`,
          properties: { highway: "primary", ref: "N44", oneway },
          geometry: { type: "LineString", coordinates: COORDS },
        }),
      )
      .join("\n"),
  );
}
function importTags(tags: Tag[], representation: Representation = "overpass", region = REGION) {
  return importOsmRoads(sql, {
    now: () => NOW,
    regions: [region],
    source: { fetchRegion: async () => waysFrom(representation, tags) },
  });
}
async function directedRows() {
  return sql<{ segment_id: string; dir: string; coords: number[][] }[]>`
    SELECT segment_id, dir, ST_AsGeoJSON(geom)::jsonb->'coordinates' AS coords
    FROM conditions.road_segment ORDER BY segment_id`;
}

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
});
afterAll(async () => db?.close(), 30_000);
beforeEach(async () => {
  await sql`TRUNCATE conditions.osm_road, conditions.road_segment, conditions.road_graph_state,
    conditions.record_binding, conditions.record_segment, conditions.binding_queue,
    conditions.sensor_segment, conditions.situation CASCADE`;
});
afterEach(() => {
  delete process.env["SEGMENT_REGIONS"];
});

describe("OSM one-way direction through the stored spine", () => {
  it.each(["overpass", "osmium"] as const)(
    "preserves direction from %s through OpenLR",
    async (representation) => {
      expect(await importTags(["-1", "1", "yes", "no", undefined], representation)).toMatchObject({
        imported: 5,
        failedRegions: [],
      });
      await buildSegments(sql, () => NOW, { region: REGION.id });
      const rows = await directedRows();
      expect(rows.map((r) => r.segment_id)).toEqual([
        "100:b",
        "101:f",
        "102:f",
        "103:b",
        "103:f",
        "104:b",
        "104:f",
      ]);
      for (const row of rows)
        expect(row.coords).toEqual(row.dir === "b" ? [...COORDS].reverse() : COORDS);
      const raw = await sql<
        { way_id: string; oneway: boolean; oneway_reversed: boolean; coords: number[][] }[]
      >`
      SELECT way_id, oneway, oneway_reversed, ST_AsGeoJSON(geom)::jsonb->'coordinates' AS coords
      FROM conditions.osm_road ORDER BY way_id`;
      expect(raw.map((r) => [r.oneway, r.oneway_reversed])).toEqual([
        [true, true],
        [true, false],
        [true, false],
        [false, false],
        [false, false],
      ]);
      expect(raw.every((r) => JSON.stringify(r.coords) === JSON.stringify(COORDS))).toBe(true);
      expect(await encodeSegmentOpenlr(sql)).toEqual({ encoded: 7 });
      const [backward] = await sql<
        { openlr: string }[]
      >`SELECT openlr FROM conditions.road_segment WHERE segment_id='100:b'`;
      const decoded = decodeOpenLrBinary(backward!.openlr);
      expect(decoded.points[0]!.longitude).toBeCloseTo(5.1, 3);
      expect(decoded.points.at(-1)!.longitude).toBeCloseTo(5, 3);
      expect(decoded.points[0]!.fow).toBe(2);
    },
    30_000,
  );

  it("removes obsolete directions when a way changes from reverse to forward to bidirectional", async () => {
    for (const [tag, expected] of [
      ["-1", ["100:b"]],
      ["yes", ["100:f"]],
      ["no", ["100:b", "100:f"]],
    ] as const) {
      await importTags([tag]);
      await buildSegments(sql, () => NOW, { region: REGION.id });
      expect((await directedRows()).map((r) => r.segment_id)).toEqual(expected);
      expect((await encodeSegmentOpenlr(sql)).encoded).toBe(expected.length);
    }
  });

  it("updates reverse orientation on a border-way upsert and preserves it on undercoverage", async () => {
    await importTags(["yes"]);
    await importTags(["-1"], "osmium", { ...REGION, id: "border" });
    await buildSegments(sql, () => NOW, { region: "border" });
    expect((await directedRows()).map((r) => r.segment_id)).toEqual(["100:b"]);
    const before = await sql`SELECT *, ST_AsEWKB(geom) AS geometry_bytes FROM conditions.osm_road`;
    expect(await importTags([], "osmium", { ...REGION, id: "border" })).toMatchObject({
      imported: 0,
      failedRegions: ["border"],
    });
    expect(await sql`SELECT *, ST_AsEWKB(geom) AS geometry_bytes FROM conditions.osm_road`).toEqual(
      before,
    );
    expect(
      await importOsmRoads(sql, {
        now: () => NOW,
        regions: [{ ...REGION, id: "border" }],
        source: {
          fetchRegion: async () => {
            throw new Error("fixture acquisition failure");
          },
        },
      }),
    ).toMatchObject({ failedRegions: ["border"] });
    expect(await sql`SELECT *, ST_AsEWKB(geom) AS geometry_bytes FROM conditions.osm_road`).toEqual(
      before,
    );
    await importTags(["1"], "overpass", { ...REGION, id: "next-border" });
    await buildSegments(sql, () => NOW, { region: "next-border" });
    expect((await directedRows()).map((r) => r.segment_id)).toEqual(["100:f"]);
    expect(await sql`SELECT region,oneway_reversed FROM conditions.osm_road`).toEqual([
      { region: "next-border", oneway_reversed: false },
    ]);
  });

  it("requires a fresh import when a legacy graph is rebuilt under unchanged region configuration", async () => {
    await importTags(["-1"]);
    const legacy = { ...osmRegionImportProvenance(REGION) };
    delete legacy["way_direction_version"];
    const oldHash = createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
    await sql`UPDATE conditions.osm_road SET import_config_hash=${oldHash}, import_provenance=${sql.json(legacy as postgres.JSONValue)}`;
    await beginRoadGraphRebuild(sql);
    await buildSegments(sql, () => NOW);
    const env = { SEGMENT_REGIONS: JSON.stringify([REGION]) };
    await expect(activateRoadGraph(sql, { now: () => NOW, env })).rejects.toThrow(
      /missing current configured imports/,
    );
    await importTags(["-1"]);
    await buildSegments(sql, () => NOW);
    await expect(activateRoadGraph(sql, { now: () => NOW, env })).resolves.toBeTypeOf("string");
  });

  it("refuses legacy direction rows in a region removed from the configured coverage", async () => {
    const env = { SEGMENT_REGIONS: JSON.stringify([REGION]) };
    await importTags(["-1"]);
    await buildSegments(sql, () => NOW);
    await activateRoadGraph(sql, { now: () => NOW, env });
    await sql`INSERT INTO conditions.osm_road (way_id,geom,highway,oneway,region,imported_at)
      VALUES (999,ST_SetSRID(ST_MakeLine(ST_MakePoint(5,52),ST_MakePoint(5.1,52)),4326),
        'primary',true,'retired',${NOW})`;
    await beginRoadGraphRebuild(sql);
    await buildSegments(sql, () => NOW);
    await expect(activateRoadGraph(sql, { now: () => NOW, env })).rejects.toThrow(
      /legacy direction imports: retired/,
    );
    expect(await sql`SELECT status FROM conditions.road_graph_state`).toEqual([
      { status: "rebuilding" },
    ]);
    // Retirement is an explicit operator decision, not an automatic data deletion.
    await sql`DELETE FROM conditions.osm_road WHERE region='retired'`;
    await buildSegments(sql, () => NOW);
    expect((await directedRows()).map((row) => row.segment_id)).toEqual(["100:b"]);
    await expect(activateRoadGraph(sql, { now: () => NOW, env })).resolves.toBeTypeOf("string");
  });

  it("rebinds a reverse-travel event to a new graph generation without retaining old forward segments", async () => {
    process.env["SEGMENT_REGIONS"] = JSON.stringify([REGION]);
    const draft = situationDraft("direction", {}, "direction-test");
    await writeSituations(sql, "direction-test", [
      {
        ...draft,
        location: {
          ...(draft["location"] as Record<string, unknown>),
          geometry: {
            type: "LineString",
            coordinates: [
              [5.08, 52.00001],
              [5.02, 52.00001],
            ],
          },
          roads: [{ ref: "N44" }],
          admin: { country: "NL" },
        },
      },
    ]);
    await seedFlowSource(sql, "direction-flow");
    await writeSiteReadings(
      sql,
      "direction-flow",
      [
        {
          site: "1",
          geometry: { type: "Point", coordinates: [5.02, 52.00001] },
          at: NOW,
          speed: 90,
        },
      ],
      NOW,
    );
    let tag = "yes";
    const fetch = (async () => new Response(overpassBody([tag]))) as typeof globalThis.fetch;
    const rebuild = () =>
      runSegmentRebuild(sql, {
        fetch,
        now: () => NOW,
        overpassUrl: "https://overpass.test/api/interpreter",
      });
    await rebuild();
    expect(
      await sql`SELECT segment_id FROM conditions.sensor_segment WHERE subject_key=${siteKey("direction-flow", "1")}`,
    ).toEqual([{ segment_id: "100:f" }]);
    const [before] = await sql<
      { generation: string }[]
    >`SELECT generation FROM conditions.road_graph_state`;
    tag = "-1";
    expect(await rebuild()).toMatchObject({ imported: 1, built: 1, encoded: 1, rebound: 1 });
    const [after] = await sql<
      { generation: string; status: string }[]
    >`SELECT generation,status FROM conditions.road_graph_state`;
    expect(after!.generation).not.toBe(before!.generation);
    expect(after!.status).toBe("ready");
    expect((await directedRows()).map((r) => r.segment_id)).toEqual(["100:b"]);
    const bound = await sql<{ segment_id: string; graph_generation: string }[]>`
      SELECT s.segment_id,b.graph_generation FROM conditions.record_segment s
      JOIN conditions.record_binding b USING(record_class,record_id,effect_id)
      WHERE s.record_id='oc:situation:direction-test:direction'`;
    const [sensor] = await sql<{ segment_id: string; fraction: number; bearing_deg: number }[]>`
      SELECT segment_id,fraction,bearing_deg FROM conditions.sensor_segment
      WHERE subject_key=${siteKey("direction-flow", "1")}`;
    expect(sensor!.segment_id).toBe("100:b");
    expect(sensor!.fraction).toBeCloseTo(0.8, 3);
    expect(sensor!.bearing_deg).toBeCloseTo(270, 1);
    expect(bound.length).toBeGreaterThan(0);
    expect(
      bound.every(
        (row) => row.segment_id === "100:b" && row.graph_generation === after!.generation,
      ),
    ).toBe(true);
  }, 60_000);
});
