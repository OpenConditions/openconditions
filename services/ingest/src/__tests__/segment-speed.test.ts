import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { writeSensorObservations } from "../pipeline/segment-speed.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";

async function seedSegment(
  segmentId: string,
  wayId: number,
  freeFlowKph: number | null
): Promise<void> {
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${segmentId}, ${wayId}, 'f',
      ST_SetSRID(ST_GeomFromText('LINESTRING(5.0 52.0, 5.1 52.0)'), 4326),
      'motorway', 8000, 5, ${freeFlowKph}, ${NOW})`;
}

async function seedFlow(
  id: string,
  source: string,
  value: number,
  freeFlowKph: number | null
): Promise<void> {
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, metric, value, status, geom, attributes, origin,
       data_updated_at, fetched_at)
    VALUES (${id}, ${source}, 'test-fmt', 'roads', 'measurement', 'flow', ${value}, 'active',
      ST_SetSRID(ST_GeomFromText('POINT(5.05 52.0)'), 4326),
      ${freeFlowKph !== null ? sql.json({ freeFlowKph }) : null},
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

describe("writeSensorObservations", () => {
  it(
    "upserts one segment_observation row per (segment, source), averaging across every " +
      "sensor of that source bound to the segment",
    async () => {
      await seedSegment("201:f", 201, 100);
      await seedFlow("nrw-1:1", "verkehr-nrw-de", 50, 100);
      await seedSensorSegment("nrw-1:1", "201:f");

      const first = await writeSensorObservations(sql, () => NOW);
      expect(first.written).toBe(1);

      const rows = await sql<
        {
          source_tier: string;
          current_kph: number;
          speed_ratio: number;
          los: string;
          sample_count: number;
          observed_at: Date;
          expires_at: Date;
        }[]
      >`SELECT source_tier, current_kph, speed_ratio, los, sample_count, observed_at, expires_at
        FROM conditions.segment_observation WHERE segment_id = '201:f' AND source = 'verkehr-nrw-de'`;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.source_tier).toBe("sensor");
      expect(Number(row.current_kph)).toBeCloseTo(50, 5);
      expect(Number(row.speed_ratio)).toBeCloseTo(0.5, 5);
      expect(row.los).toBe("heavy");
      expect(Number(row.sample_count)).toBe(1);
      expect(row.expires_at.getTime()).toBeGreaterThan(row.observed_at.getTime());

      // A second sensor of the same source bound to the same segment: the
      // row must be averaged in place, not duplicated.
      await seedFlow("nrw-2:1", "verkehr-nrw-de", 70, 100);
      await seedSensorSegment("nrw-2:1", "201:f");

      const second = await writeSensorObservations(sql, () => NOW);
      expect(second.written).toBe(1);

      const merged = await sql<{ current_kph: number; sample_count: number }[]>`
        SELECT current_kph, sample_count FROM conditions.segment_observation
        WHERE segment_id = '201:f' AND source = 'verkehr-nrw-de'`;
      expect(merged).toHaveLength(1);
      expect(Number(merged[0]!.current_kph)).toBeCloseTo(60, 5);
      expect(Number(merged[0]!.sample_count)).toBe(2);
    },
    30_000
  );

  it("leaves los 'unknown' and speed_ratio NULL when no free-flow speed is known (Trafikverket-like)", async () => {
    await seedSegment("202:f", 202, null);
    await seedFlow("trv-1:1", "trafikverket-se", 50, null);
    await seedSensorSegment("trv-1:1", "202:f");

    await writeSensorObservations(sql, () => NOW);

    const rows = await sql<
      { los: string; speed_ratio: number | null; free_flow_kph: number | null }[]
    >`SELECT los, speed_ratio, free_flow_kph FROM conditions.segment_observation
      WHERE segment_id = '202:f' AND source = 'trafikverket-se'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.los).toBe("unknown");
    expect(rows[0]!.speed_ratio).toBeNull();
    expect(rows[0]!.free_flow_kph).toBeNull();
  }, 30_000);
});
