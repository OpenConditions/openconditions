import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";

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
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("segment schema", () => {
  it("creates the segment spine tables with a directed PK", async () => {
    const cols = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema='conditions' AND table_name='road_segment'`;
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        "segment_id",
        "way_id",
        "dir",
        "geom",
        "highway",
        "min_zoom",
        "free_flow_kph",
      ])
    );
    const idx =
      await sql`SELECT indexname FROM pg_indexes WHERE schemaname='conditions' AND tablename='road_segment'`;
    expect(idx.map((i) => i.indexname)).toContain("idx_road_segment_geom");
  }, 30_000);

  it("creates osm_road with a bigint primary key", async () => {
    await sql`
      INSERT INTO conditions.osm_road (way_id, geom, highway, oneway, region, imported_at)
      VALUES (12345, ST_SetSRID(ST_GeomFromGeoJSON('{"type":"LineString","coordinates":[[24.9,60.2],[24.91,60.21]]}'), 4326),
        'primary', true, 'fi', now())`;
    const rows = await sql<
      { way_id: string }[]
    >`SELECT way_id FROM conditions.osm_road WHERE way_id = 12345`;
    expect(rows).toHaveLength(1);
  }, 30_000);

  it("binds a sensor to a segment via sensor_segment", async () => {
    await sql`
      INSERT INTO conditions.road_segment
        (segment_id, way_id, dir, geom, highway, length_m, min_zoom, computed_at)
      VALUES ('12345:f', 12345, 'f',
        ST_SetSRID(ST_GeomFromGeoJSON('{"type":"LineString","coordinates":[[24.9,60.2],[24.91,60.21]]}'), 4326),
        'primary', 650.0, 9, now())`;
    await sql`
      INSERT INTO conditions.sensor_segment (sensor_key, segment_id, fraction, offset_m, matched_at)
      VALUES ('fi:1', '12345:f', 0.5, 3.2, now())`;
    const rows = await sql<{ segment_id: string }[]>`
      SELECT segment_id FROM conditions.sensor_segment WHERE sensor_key = 'fi:1'`;
    expect(rows[0]!.segment_id).toBe("12345:f");
  }, 30_000);
});
