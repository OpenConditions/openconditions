import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { matchSensors } from "../pipeline/sensor-match.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";

// A short A12 motorway segment running due east along lat 52.0.
const SEGMENT_WKT = "LINESTRING(5.0 52.0, 5.1 52.0)";

async function seedSegment(segmentId: string, wayId: number, wkt: string): Promise<void> {
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${segmentId}, ${wayId}, 'f', ST_SetSRID(ST_GeomFromText(${wkt}), 4326), 'motorway', 'A12',
      8000, 5, 120, ${NOW})`;
}

async function seedFlow(id: string, wkt: string, roads: string | null): Promise<void> {
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, metric, status, geom, attributes, origin,
       data_updated_at, fetched_at)
    VALUES (${id}, 'test-src', 'test-fmt', 'roads', 'measurement', 'flow', 'active',
      ST_SetSRID(ST_GeomFromText(${wkt}), 4326),
      ${roads ? sql.json({ roads }) : null},
      ${sql.json({ kind: "feed", attribution: { provider: "test" } })},
      ${NOW}, ${NOW})`;
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

describe("matchSensors", () => {
  it("snaps a nearby flow sensor to its ref-matching segment, rejects a far one, and matches a LineString sensor via its midpoint", async () => {
    await seedSegment("111:f", 111, SEGMENT_WKT);

    // ~11 m north of the segment (0.0001 deg lat), at the segment's midpoint longitude.
    await seedFlow("a12-near:1", "POINT(5.05 52.0001)", "A12");
    // ~200 m north of the segment — well past the 35 m offset gate.
    await seedFlow("a12-far:1", "POINT(5.05 52.0018)", "A12");

    const first = await matchSensors(sql, () => NOW);
    expect(first.matched).toBe(1);

    const nearRow = await sql<{ segment_id: string; fraction: number; offset_m: number }[]>`
      SELECT segment_id, fraction, offset_m FROM conditions.sensor_segment WHERE sensor_key = 'a12-near:1'`;
    expect(nearRow).toHaveLength(1);
    expect(nearRow[0]).toMatchObject({ segment_id: "111:f" });
    expect(Number(nearRow[0]!.offset_m)).toBeLessThan(35);
    expect(Number(nearRow[0]!.fraction)).toBeGreaterThan(0);
    expect(Number(nearRow[0]!.fraction)).toBeLessThan(1);

    const farRow =
      await sql`SELECT 1 FROM conditions.sensor_segment WHERE sensor_key = 'a12-far:1'`;
    expect(farRow).toHaveLength(0);

    // Regression: a LineString observation (the NYC DOT shape) must be reduced
    // to its midpoint by the `sp` lateral before ST_LineLocatePoint runs, or
    // the whole INSERT errors. Its midpoint sits at the same ~11 m offset as
    // the near point above.
    await seedFlow("a12-line:1", "LINESTRING(5.02 52.0001, 5.08 52.0001)", "A12");

    const second = await matchSensors(sql, () => NOW);
    expect(second.matched).toBe(2);

    const lineRow = await sql<{ segment_id: string; offset_m: number; fraction: number }[]>`
      SELECT segment_id, offset_m, fraction FROM conditions.sensor_segment WHERE sensor_key = 'a12-line:1'`;
    expect(lineRow).toHaveLength(1);
    expect(lineRow[0]).toMatchObject({ segment_id: "111:f" });
    expect(Number(lineRow[0]!.offset_m)).toBeLessThan(35);
    expect(Number(lineRow[0]!.fraction)).toBeGreaterThan(0);
    expect(Number(lineRow[0]!.fraction)).toBeLessThan(1);

    // The far sensor is still gated out on the re-run.
    const farRowAgain =
      await sql`SELECT 1 FROM conditions.sensor_segment WHERE sensor_key = 'a12-far:1'`;
    expect(farRowAgain).toHaveLength(0);
  }, 30_000);
});
