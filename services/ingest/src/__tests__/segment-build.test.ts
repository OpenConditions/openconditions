import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { buildSegments } from "../pipeline/segment-build.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";
const PAST = "2025-01-01T00:00:00.000Z";

const NL_MOTORWAY_WKT = "LINESTRING(4.0 52.0, 4.01 52.01)";
const NL_PRIMARY_WKT = "LINESTRING(5.0 52.0, 5.02 52.02, 5.04 52.04)";
const SE_WKT = "LINESTRING(18.0 59.0, 18.01 59.01)";

async function coordsOf(segmentId: string): Promise<number[][]> {
  const rows = await sql<{ coords: number[][] }[]>`
    SELECT (ST_AsGeoJSON(geom)::json ->> 'coordinates')::jsonb AS coords
    FROM conditions.road_segment WHERE segment_id = ${segmentId}`;
  return rows[0]!.coords as unknown as number[][];
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

async function seed(): Promise<void> {
  await sql`
    INSERT INTO conditions.osm_road (way_id, geom, highway, oneway, ref, maxspeed_kph, region, imported_at)
    VALUES
      (100, ST_SetSRID(ST_GeomFromText(${NL_MOTORWAY_WKT}), 4326), 'motorway', true, 'A1', 120, 'nl', ${NOW}),
      (200, ST_SetSRID(ST_GeomFromText(${NL_PRIMARY_WKT}), 4326), 'primary', false, 'N44', 80, 'nl', ${NOW}),
      (300, ST_SetSRID(ST_GeomFromText(${SE_WKT}), 4326), 'primary', false, 'E20', 90, 'se', ${NOW})`;

  // Pre-existing se segment, as if a prior build already ran for that region —
  // proves a scoped `nl` build never touches it.
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES ('300:f', 300, 'f', ST_SetSRID(ST_GeomFromText(${SE_WKT}), 4326), 'primary', 'E20', 1000, 9, 90, ${PAST})`;

  // An orphan: a segment whose way has already vanished from osm_road entirely.
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES ('999:f', 999, 'f', ST_SetSRID(ST_GeomFromText(${NL_MOTORWAY_WKT}), 4326), 'motorway', 500, 5, 100, ${PAST})`;
}

describe("buildSegments", () => {
  it("rebuilds one region's directed segments, leaves other regions alone, and sweeps orphans", async () => {
    await seed();

    const result = await buildSegments(sql, () => NOW, { region: "nl" });
    expect(result.built).toBe(3);

    const nlRows = await sql<
      { segment_id: string; dir: string; min_zoom: number; free_flow_kph: number }[]
    >`SELECT segment_id, dir, min_zoom, free_flow_kph FROM conditions.road_segment
      WHERE way_id IN (100, 200) ORDER BY segment_id`;
    expect(nlRows.map((r) => r.segment_id)).toEqual(["100:f", "200:b", "200:f"]);

    const motorway = nlRows.find((r) => r.segment_id === "100:f")!;
    expect(motorway.min_zoom).toBe(5);
    expect(Number(motorway.free_flow_kph)).toBe(120);

    const primaryF = nlRows.find((r) => r.segment_id === "200:f")!;
    expect(primaryF.min_zoom).toBe(9);
    expect(Number(primaryF.free_flow_kph)).toBe(80);

    const forwardCoords = await coordsOf("200:f");
    const backwardCoords = await coordsOf("200:b");
    expect(backwardCoords).toEqual([...forwardCoords].reverse());

    // se was seeded, but never rebuilt by this nl-scoped call — untouched.
    const seRow = await sql<{ computed_at: Date }[]>`
      SELECT computed_at FROM conditions.road_segment WHERE segment_id = '300:f'`;
    expect(seRow).toHaveLength(1);
    expect(seRow[0]!.computed_at.toISOString()).toBe(PAST);

    // the orphan (way_id 999 has no osm_road row in any region) is swept.
    const orphan = await sql`SELECT 1 FROM conditions.road_segment WHERE segment_id = '999:f'`;
    expect(orphan).toHaveLength(0);

    // the oneway motorway only ever built a forward segment, never a spurious reverse.
    expect(nlRows.filter((r) => r.segment_id.startsWith("100:")).map((r) => r.dir)).toEqual(["f"]);
  }, 30_000);
});
