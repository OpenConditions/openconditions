import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import {
  fuseSegmentSpeed,
  propagateSegmentSpeed,
  writeSensorObservations,
} from "../pipeline/segment-speed.js";

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

async function seedRefSegment(
  segmentId: string,
  wayId: number,
  dir: string,
  wkt: string,
  ref: string,
  freeFlowKph: number | null,
  lengthM = 1000
): Promise<void> {
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${segmentId}, ${wayId}, ${dir},
      ST_SetSRID(ST_GeomFromText(${wkt}), 4326),
      'motorway', ${ref}, ${lengthM}, 5, ${freeFlowKph}, ${NOW})`;
}

async function seedSpeed(
  segmentId: string,
  currentKph: number,
  freeFlowKph: number,
  isEstimated: boolean
): Promise<void> {
  const ratio = currentKph / freeFlowKph;
  const los =
    ratio >= 0.85 ? "free_flow" : ratio >= 0.5 ? "heavy" : ratio >= 0.15 ? "queuing" : "stationary";
  await sql`
    INSERT INTO conditions.segment_speed
      (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, source_tier, contributing, is_estimated, observed_at, updated_at)
    VALUES (${segmentId}, ${currentKph}, ${freeFlowKph}, ${ratio}, ${los},
      ${isEstimated ? "estimated" : "measured"}, 'sensor', ARRAY['test-source'], ${isEstimated}, ${NOW}, ${NOW})`;
}

async function seedObservation(
  segmentId: string,
  source: string,
  sourceTier: string,
  currentKph: number,
  observedAt: string,
  expiresAt: string | null
): Promise<void> {
  await sql`
    INSERT INTO conditions.segment_observation
      (segment_id, source, source_tier, current_kph, free_flow_kph, speed_ratio, los, confidence, sample_count, observed_at, expires_at)
    VALUES (${segmentId}, ${source}, ${sourceTier}, ${currentKph}, 100, ${currentKph / 100}, 'heavy', 0.9, 1,
      ${observedAt}, ${expiresAt})`;
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

  it("keeps one row per (segment, source): two sources on one segment produce two rows, each averaged within its own source", async () => {
    await seedSegment("203:f", 203, 100);
    await seedFlow("nrw-a:1", "verkehr-nrw-de", 50, 100);
    await seedSensorSegment("nrw-a:1", "203:f");
    await seedFlow("trv-a:1", "trafikverket-se", 70, 100);
    await seedSensorSegment("trv-a:1", "203:f");

    await writeSensorObservations(sql, () => NOW);

    const rows = await sql<{ source: string; current_kph: number; sample_count: number }[]>`
      SELECT source, current_kph, sample_count FROM conditions.segment_observation
      WHERE segment_id = '203:f' ORDER BY source`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source)).toEqual(["trafikverket-se", "verkehr-nrw-de"]);
    const bySource = new Map(rows.map((r) => [r.source, r]));
    expect(Number(bySource.get("verkehr-nrw-de")!.current_kph)).toBeCloseTo(50, 5);
    expect(Number(bySource.get("verkehr-nrw-de")!.sample_count)).toBe(1);
    expect(Number(bySource.get("trafikverket-se")!.current_kph)).toBeCloseTo(70, 5);
    expect(Number(bySource.get("trafikverket-se")!.sample_count)).toBe(1);
  }, 30_000);

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

describe("fuseSegmentSpeed", () => {
  it(
    "reduces multiple live segment_observation rows to one measured segment_speed row, " +
      "taking the highest tier (authoritative over sensor) and listing all live sources in " +
      "contributing; an expired observation is ignored entirely",
    async () => {
      await seedSegment("301:f", 301, 100);
      await seedObservation(
        "301:f",
        "verkehr-nrw-de",
        "sensor",
        50,
        NOW,
        "2026-01-01T00:15:00.000Z"
      );
      await seedObservation(
        "301:f",
        "incident-authority",
        "authoritative",
        80,
        NOW,
        "2026-01-01T00:15:00.000Z"
      );
      await seedObservation(
        "301:f",
        "stale-peer",
        "peer",
        30,
        "2025-12-31T00:00:00.000Z",
        "2025-12-31T00:15:00.000Z"
      );

      // Prior tests in this file seed their own segments' observations into
      // the same shared testcontainer, so `measured` legitimately covers every
      // segment with a still-live observation, not just this test's `301:f`.
      const [{ count: liveSegments }] = await sql<{ count: string }[]>`
        SELECT count(DISTINCT segment_id)::text AS count FROM conditions.segment_observation
        WHERE expires_at IS NULL OR expires_at > ${NOW}::timestamptz`;

      const result = await fuseSegmentSpeed(sql, () => NOW);
      expect(result.measured).toBe(Number(liveSegments));

      const rows = await sql<
        {
          current_kph: number;
          source_tier: string;
          confidence: string;
          is_estimated: boolean;
          contributing: string[];
        }[]
      >`SELECT current_kph, source_tier, confidence, is_estimated, contributing
        FROM conditions.segment_speed WHERE segment_id = '301:f'`;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(Number(row.current_kph)).toBeCloseTo(80, 5);
      expect(row.source_tier).toBe("authoritative");
      expect(row.confidence).toBe("measured");
      expect(row.is_estimated).toBe(false);
      expect([...row.contributing].sort()).toEqual(["incident-authority", "verkehr-nrw-de"]);
    },
    30_000
  );
});

describe("propagateSegmentSpeed", () => {
  it(
    "lends a measured segment's absolute speed onto a continuing same-ref/highway gap segment " +
      "(ratio recomputed against the gap's own free-flow speed), never overwrites a segment that " +
      "already has its own speed row, rejects an endpoint-adjacent but antiparallel (reversed-twin) " +
      "neighbor, and clears the estimate once its source measurement is gone",
    async () => {
      // A: measured, current_kph=40, heading east.
      await seedRefSegment("900:f", 900, "f", "LINESTRING(5.0 52.0, 5.1 52.0)", "prop-a1", 100);
      await seedSpeed("900:f", 40, 100, false);

      // B: continuation of A (B's start = A's end), no speed of its own yet,
      // own free_flow_kph=120 -- the row propagateSegmentSpeed should fill.
      await seedRefSegment("901:f", 901, "f", "LINESTRING(5.1 52.0, 5.2 52.0)", "prop-a1", 120);

      // D: also a valid continuation of A geometrically, but already carries
      // its own measured row -- must survive untouched.
      await seedRefSegment("902:f", 902, "f", "LINESTRING(5.1 52.0, 5.15 52.0)", "prop-a1", 100);
      await seedSpeed("902:f", 99, 100, false);

      // C: the reversed twin of A itself (same endpoints, opposite direction)
      // -- endpoint-adjacent to A but ~180 degrees off bearing, must be rejected.
      await seedRefSegment("903:f", 903, "b", "LINESTRING(5.1 52.0, 5.0 52.0)", "prop-a1", 100);

      await propagateSegmentSpeed(sql, () => NOW);

      const b = await sql<
        {
          is_estimated: boolean;
          confidence: string;
          current_kph: number;
          free_flow_kph: number;
          speed_ratio: number;
          los: string;
        }[]
      >`SELECT is_estimated, confidence, current_kph, free_flow_kph, speed_ratio, los
        FROM conditions.segment_speed WHERE segment_id = '901:f'`;
      expect(b).toHaveLength(1);
      expect(b[0]!.is_estimated).toBe(true);
      expect(b[0]!.confidence).toBe("estimated");
      expect(Number(b[0]!.current_kph)).toBeCloseTo(40, 5);
      expect(Number(b[0]!.free_flow_kph)).toBeCloseTo(120, 5);
      expect(Number(b[0]!.speed_ratio)).toBeCloseTo(0.3333, 2);
      expect(b[0]!.los).toBe("queuing");

      const d = await sql<{ is_estimated: boolean; confidence: string; current_kph: number }[]>`
        SELECT is_estimated, confidence, current_kph FROM conditions.segment_speed WHERE segment_id = '902:f'`;
      expect(d).toHaveLength(1);
      expect(d[0]!.is_estimated).toBe(false);
      expect(d[0]!.confidence).toBe("measured");
      expect(Number(d[0]!.current_kph)).toBeCloseTo(99, 5);

      const c =
        await sql`SELECT segment_id FROM conditions.segment_speed WHERE segment_id = '903:f'`;
      expect(c).toHaveLength(0);

      // Stale-estimate regression: once A's own measurement is gone, re-running
      // must clear B's estimate rather than let it survive forever via ON CONFLICT DO NOTHING.
      await sql`DELETE FROM conditions.segment_speed WHERE segment_id = '900:f'`;
      await propagateSegmentSpeed(sql, () => NOW);

      const bAfter =
        await sql`SELECT segment_id FROM conditions.segment_speed WHERE segment_id = '901:f'`;
      expect(bAfter).toHaveLength(0);
    },
    30_000
  );

  it(
    "does not lend a reading onto a neighbor longer than the length cap even when it is an " +
      "endpoint-adjacent, bearing-aligned continuation",
    async () => {
      // A: measured, heading east.
      await seedRefSegment("910:f", 910, "f", "LINESTRING(6.0 53.0, 6.1 53.0)", "prop-len", 100);
      await seedSpeed("910:f", 40, 100, false);

      // B: a perfect continuation of A (start = A's end, same eastward bearing)
      // whose stored length exceeds the 3 km cap -- one sensor must not paint it.
      await seedRefSegment(
        "911:f",
        911,
        "f",
        "LINESTRING(6.1 53.0, 6.2 53.0)",
        "prop-len",
        120,
        4000
      );

      await propagateSegmentSpeed(sql, () => NOW);

      const b =
        await sql`SELECT segment_id FROM conditions.segment_speed WHERE segment_id = '911:f'`;
      expect(b).toHaveLength(0);
    },
    30_000
  );

  it(
    "does not lend a reading onto a parallel, bearing-aligned opposite-carriageway neighbor whose " +
      "whole geometry is within tolerance but whose endpoints do not touch the measured segment's endpoints",
    async () => {
      // A: measured, heading east along lat 53.0.
      await seedRefSegment("920:f", 920, "f", "LINESTRING(7.0 53.0, 7.1 53.0)", "prop-par", 100);
      await seedSpeed("920:f", 40, 100, false);

      // P: same ref/highway, runs parallel ~20 m north and the SAME eastward
      // direction (so the bearing gate does not exclude it). Its whole geometry
      // is within the 50 m tolerance of A, but its start/end are ~6.7 km from
      // A's end/start respectively, so the endpoint-continuation gate rejects it.
      // A blanket whole-geometry ST_DWithin would wrongly fill it.
      await seedRefSegment(
        "921:f",
        921,
        "f",
        "LINESTRING(7.0 53.00018, 7.1 53.00018)",
        "prop-par",
        120
      );

      await propagateSegmentSpeed(sql, () => NOW);

      const p =
        await sql`SELECT segment_id FROM conditions.segment_speed WHERE segment_id = '921:f'`;
      expect(p).toHaveLength(0);
    },
    30_000
  );
});
