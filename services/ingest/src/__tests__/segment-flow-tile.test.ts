import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";

// A single segment near Utrecht, NL: lon 5.1, lat 52.1.
const SEGMENT_ID = "500:f";
const SEGMENT_WKT = "LINESTRING(5.1 52.1, 5.11 52.1)";

// z=8 tile covering lon/lat 5.1/52.1 (computed via the standard slippy-map
// formula), well above the segment's min_zoom of 5 so the LOD filter passes.
const COVERING_Z = 8;
const COVERING_X = 131;
const COVERING_Y = 84;

// A tile far from the seeded segment (mid-Pacific, lon -170/lat 0) at the
// same zoom -- must produce an empty MVT.
const FAR_Z = 8;
const FAR_X = 7;
const FAR_Y = 128;

// A second, isolated segment (lon 10.0, lat 45.0) with NO segment_speed row,
// alone in its own tile -- no co-located segment-with-speed to mask an
// accidental INNER JOIN. z10 (540,368) covers only this segment.
const NOSPEED_SEGMENT_ID = "600:f";
const NOSPEED_WKT = "LINESTRING(10.0 45.0, 10.01 45.0)";
const NOSPEED_Z = 10;
const NOSPEED_X = 540;
const NOSPEED_Y = 368;

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

  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${SEGMENT_ID}, 500, 'f',
      ST_SetSRID(ST_GeomFromText(${SEGMENT_WKT}), 4326),
      'motorway', 1000, 5, 100, ${NOW})`;
  await sql`
    INSERT INTO conditions.segment_speed
      (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, source_tier, contributing, is_estimated, observed_at, updated_at)
    VALUES (${SEGMENT_ID}, 50, 100, 0.5, 'heavy', 'measured', 'sensor', ARRAY['test-source'], false, ${NOW}, ${NOW})`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("conditions.segment_flow", () => {
  it("renders a non-empty MVT for a tile covering a segment with a fused speed row, joining segment_speed attributes in", async () => {
    const rows = await sql<{ len: number }[]>`
      SELECT length(conditions.segment_flow(${COVERING_Z}, ${COVERING_X}, ${COVERING_Y}, '{}'::json)) AS len`;
    expect(rows[0]!.len).toBeGreaterThan(0);
  }, 30_000);

  it("renders an empty MVT for a tile far from any segment", async () => {
    const rows = await sql<{ len: number }[]>`
      SELECT length(conditions.segment_flow(${FAR_Z}, ${FAR_X}, ${FAR_Y}, '{}'::json)) AS len`;
    expect(rows[0]!.len).toBe(0);
  }, 30_000);

  it("renders a segment with NO segment_speed row (proves LEFT JOIN, not INNER): its tile contains only that speed-less segment and must still be non-empty", async () => {
    await sql`
      INSERT INTO conditions.road_segment
        (segment_id, way_id, dir, geom, highway, length_m, min_zoom, free_flow_kph, computed_at)
      VALUES (${NOSPEED_SEGMENT_ID}, 600, 'f',
        ST_SetSRID(ST_GeomFromText(${NOSPEED_WKT}), 4326),
        'motorway', 1000, 5, 100, ${NOW})`;

    // Guard the premise: this tile must contain the speed-less segment and no
    // segment that has a segment_speed row -- otherwise an INNER JOIN could
    // still yield a non-empty tile and the test would not be diagnostic.
    const [{ with_speed, without_speed }] = await sql<
      { with_speed: number; without_speed: number }[]
    >`
      SELECT
        count(*) FILTER (WHERE sp.segment_id IS NOT NULL)::int AS with_speed,
        count(*) FILTER (WHERE sp.segment_id IS NULL)::int AS without_speed
      FROM conditions.road_segment s
      LEFT JOIN conditions.segment_speed sp USING (segment_id)
      WHERE s.geom && ST_Transform(ST_TileEnvelope(${NOSPEED_Z}, ${NOSPEED_X}, ${NOSPEED_Y}), 4326)`;
    expect(with_speed).toBe(0);
    expect(without_speed).toBe(1);

    const rows = await sql<{ len: number }[]>`
      SELECT length(conditions.segment_flow(${NOSPEED_Z}, ${NOSPEED_X}, ${NOSPEED_Y}, '{}'::json)) AS len`;
    expect(rows[0]!.len).toBeGreaterThan(0);
  }, 30_000);
});
