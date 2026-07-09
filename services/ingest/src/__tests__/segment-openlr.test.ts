import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { decodeOpenLrBinary } from "@openconditions/openlr";
import { encodeSegmentOpenlr } from "../pipeline/segment-openlr.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";
const MOTORWAY_WKT = "LINESTRING(4.895 52.37, 4.9 52.371, 4.905 52.372)";
const PRIMARY_WKT = "LINESTRING(5.0 52.0, 5.02 52.02, 5.04 52.04)";

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
      (100, ST_SetSRID(ST_GeomFromText(${MOTORWAY_WKT}), 4326), 'motorway', true, 'A1', 120, 'nl', ${NOW}),
      (200, ST_SetSRID(ST_GeomFromText(${PRIMARY_WKT}), 4326), 'primary', false, 'N44', 80, 'nl', ${NOW})`;

  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES
      ('100:f', 100, 'f', ST_SetSRID(ST_GeomFromText(${MOTORWAY_WKT}), 4326), 'motorway', 'A1', 700, 5, 120, ${NOW}),
      ('200:f', 200, 'f', ST_SetSRID(ST_GeomFromText(${PRIMARY_WKT}), 4326), 'primary', 'N44', 4000, 9, 80, ${NOW}),
      ('200:b', 200, 'b', ST_Reverse(ST_SetSRID(ST_GeomFromText(${PRIMARY_WKT}), 4326)), 'primary', 'N44', 4000, 9, 80, ${NOW})`;
}

describe("encodeSegmentOpenlr", () => {
  it("encodes every segment missing an openlr descriptor, resolvable near its geometry", async () => {
    await seed();

    const result = await encodeSegmentOpenlr(sql);
    expect(result.encoded).toBe(3);

    const rows = await sql<{ segment_id: string; openlr: string | null }[]>`
      SELECT segment_id, openlr FROM conditions.road_segment ORDER BY segment_id`;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.openlr).not.toBeNull();
    }

    const motorway = rows.find((r) => r.segment_id === "100:f")!;
    const decoded = decodeOpenLrBinary(motorway.openlr!);
    expect(decoded.points[0]!.longitude).toBeCloseTo(4.895, 3);
    expect(decoded.points[0]!.latitude).toBeCloseTo(52.37, 3);
    expect(decoded.points[0]!.frc).toBe(0);
    expect(decoded.points[0]!.fow).toBe(1);

    const primaryForward = rows.find((r) => r.segment_id === "200:f")!;
    const primaryBackward = rows.find((r) => r.segment_id === "200:b")!;
    const decodedForward = decodeOpenLrBinary(primaryForward.openlr!);
    const decodedBackward = decodeOpenLrBinary(primaryBackward.openlr!);
    expect(decodedForward.points[0]!.longitude).toBeCloseTo(5.0, 3);
    expect(decodedBackward.points[0]!.longitude).toBeCloseTo(5.04, 3);
    expect(decodedForward.points[0]!.fow).toBe(3);
  });

  it("is a no-op re-run once every segment already has an openlr descriptor", async () => {
    const result = await encodeSegmentOpenlr(sql);
    expect(result.encoded).toBe(0);
  });

  it("skips a degenerate-geometry segment without aborting the batch", async () => {
    await sql`
      INSERT INTO conditions.osm_road (way_id, geom, highway, oneway, ref, maxspeed_kph, region, imported_at)
      VALUES
        (400, ST_SetSRID(ST_GeomFromText(${MOTORWAY_WKT}), 4326), 'motorway', true, 'A2', 120, 'nl', ${NOW}),
        (500, ST_SetSRID(ST_GeomFromText('LINESTRING EMPTY'), 4326), 'primary', false, 'N99', 80, 'nl', ${NOW})`;
    await sql`
      INSERT INTO conditions.road_segment
        (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
      VALUES
        ('400:f', 400, 'f', ST_SetSRID(ST_GeomFromText(${MOTORWAY_WKT}), 4326), 'motorway', 'A2', 700, 5, 120, ${NOW}),
        ('500:f', 500, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING EMPTY'), 4326), 'primary', 'N99', 0, 9, 80, ${NOW})`;

    const result = await encodeSegmentOpenlr(sql);
    expect(result.encoded).toBe(1);

    const valid = await sql<{ openlr: string | null }[]>`
      SELECT openlr FROM conditions.road_segment WHERE segment_id = '400:f'`;
    expect(valid[0]!.openlr).not.toBeNull();

    const degenerate = await sql<{ openlr: string | null }[]>`
      SELECT openlr FROM conditions.road_segment WHERE segment_id = '500:f'`;
    expect(degenerate[0]!.openlr).toBeNull();
  });
});
