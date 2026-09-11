import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { refreshSegmentSpeed } from "../pipeline/segment-speed.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";

async function seedSegment(
  segmentId: string,
  wayId: number,
  dir: string,
  ref: string,
  wkt: string,
  freeFlowKph: number
): Promise<void> {
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${segmentId}, ${wayId}, ${dir},
      ST_SetSRID(ST_GeomFromText(${wkt}), 4326),
      'motorway', ${ref}, 1000, 5, ${freeFlowKph}, ${NOW})`;
}

async function seedFlow(
  id: string,
  source: string,
  value: number,
  freeFlowKph: number
): Promise<void> {
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, metric, value, status, geom, attributes, origin,
       data_updated_at, fetched_at)
    VALUES (${id}, ${source}, 'test-fmt', 'roads', 'measurement', 'flow', ${value}, 'active',
      ST_SetSRID(ST_GeomFromText('POINT(6.05 50.0)'), 4326),
      ${sql.json({ freeFlowKph })},
      ${sql.json({ kind: "feed", attribution: { provider: "test" } })},
      ${NOW}, ${NOW})`;
}

async function seedSensorSegment(sensorKey: string, segmentId: string): Promise<void> {
  await sql`
    INSERT INTO conditions.sensor_segment (sensor_key, segment_id, fraction, offset_m, matched_at)
    VALUES (${sensorKey}, ${segmentId}, 0.5, 5.0, ${NOW})`;
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

describe("refreshSegmentSpeed", () => {
  it(
    "runs write -> fuse -> propagate in order, yielding one measured segment_speed row for the " +
      "sensored segment and one estimated row for its continuing gap neighbor",
    async () => {
      // A: bound flow sensor via sensor_segment, current 40 kph on a 100 kph
      // free-flow segment.
      await seedSegment("940:f", 940, "f", "job-a1", "LINESTRING(6.0 50.0, 6.1 50.0)", 100);
      await seedFlow("job-sensor:1", "job-test-src", 40, 100);
      await seedSensorSegment("job-sensor:1", "940:f");

      // B: continuation of A (B's start = A's end, same ref/highway), no
      // sensor of its own -- the row propagateSegmentSpeed should fill.
      await seedSegment("941:f", 941, "f", "job-a1", "LINESTRING(6.1 50.0, 6.2 50.0)", 120);

      const result = await refreshSegmentSpeed(sql, () => NOW);
      expect(result.written).toBe(1);
      expect(result.measured).toBe(1);
      expect(result.estimated).toBe(1);

      const measured = await sql<
        { is_estimated: boolean; confidence: string; current_kph: number }[]
      >`SELECT is_estimated, confidence, current_kph FROM conditions.segment_speed WHERE segment_id = '940:f'`;
      expect(measured).toHaveLength(1);
      expect(measured[0]!.is_estimated).toBe(false);
      expect(measured[0]!.confidence).toBe("measured");
      expect(Number(measured[0]!.current_kph)).toBeCloseTo(40, 5);

      const estimated = await sql<
        { is_estimated: boolean; confidence: string; current_kph: number; free_flow_kph: number }[]
      >`SELECT is_estimated, confidence, current_kph, free_flow_kph FROM conditions.segment_speed WHERE segment_id = '941:f'`;
      expect(estimated).toHaveLength(1);
      expect(estimated[0]!.is_estimated).toBe(true);
      expect(estimated[0]!.confidence).toBe("estimated");
      expect(Number(estimated[0]!.current_kph)).toBeCloseTo(40, 5);
      expect(Number(estimated[0]!.free_flow_kph)).toBeCloseTo(120, 5);
    },
    30_000
  );
});
