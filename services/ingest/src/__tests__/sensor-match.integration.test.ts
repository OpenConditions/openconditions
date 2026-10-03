import { runMigrations } from "@openconditions/core/server";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchSensors } from "../pipeline/sensor-match.js";
import {
  type SiteReading,
  seedFlowSource,
  siteKey,
  writeSiteFeature,
  writeSiteReadings,
} from "./helpers/flow-series.js";

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

const SRC = "test-src";
const at = NOW;

/** A site's speed reading at `geometry`, as a flow poll writes it. */
async function seedSite(site: string, geometry: SiteReading["geometry"], source = SRC) {
  await seedFlowSource(sql, source);
  await writeSiteReadings(sql, source, [{ site, geometry, at, speed: 80 }], NOW);
}

const point = (lon: number, lat: number) => ({ type: "Point" as const, coordinates: [lon, lat] });

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
  it("snaps a nearby site to its segment, rejects a far one, and matches line sites via the first line's midpoint", async () => {
    await seedSegment("111:f", 111, SEGMENT_WKT);

    // ~11 m north of the segment (0.0001 deg lat), at the segment's midpoint longitude.
    await seedSite("near", point(5.05, 52.0001));
    // ~200 m north of the segment — well past the 35 m offset gate.
    await seedSite("far", point(5.05, 52.0018));

    const first = await matchSensors(sql, () => NOW);
    expect(first.matched).toBe(1);

    const nearRow = await sql<{ segment_id: string; fraction: number; offset_m: number }[]>`
      SELECT segment_id, fraction, offset_m FROM conditions.sensor_segment
       WHERE subject_key = ${siteKey(SRC, "near")}`;
    expect(nearRow).toHaveLength(1);
    expect(nearRow[0]).toMatchObject({ segment_id: "111:f" });
    expect(Number(nearRow[0]!.offset_m)).toBeLessThan(35);
    expect(Number(nearRow[0]!.fraction)).toBeGreaterThan(0);
    expect(Number(nearRow[0]!.fraction)).toBeLessThan(1);

    const farRow = await sql`SELECT 1 FROM conditions.sensor_segment
      WHERE subject_key = ${siteKey(SRC, "far")}`;
    expect(farRow).toHaveLength(0);

    // A LineString site (the NYC DOT shape) is reduced to its midpoint, and a
    // MultiLineString site (a site whose readings span several lines) to the
    // midpoint of its first line, before ST_LineLocatePoint runs.
    await seedSite("line", {
      type: "LineString",
      coordinates: [
        [5.02, 52.0001],
        [5.08, 52.0001],
      ],
    });
    await seedSite("multi", {
      type: "MultiLineString",
      coordinates: [
        [
          [5.03, 52.0001],
          [5.07, 52.0001],
        ],
        [
          [5.5, 52.5],
          [5.6, 52.5],
        ],
      ],
    });

    const second = await matchSensors(sql, () => NOW);
    expect(second.matched).toBe(3);

    const lineRows = await sql<{ subject_key: string; segment_id: string; offset_m: number }[]>`
      SELECT subject_key, segment_id, offset_m FROM conditions.sensor_segment
       WHERE subject_key IN (${siteKey(SRC, "line")}, ${siteKey(SRC, "multi")})
       ORDER BY subject_key`;
    expect(lineRows.map((r) => r.segment_id)).toEqual(["111:f", "111:f"]);
    expect(lineRows.every((r) => Number(r.offset_m) < 35)).toBe(true);
  }, 30_000);

  it("snaps a site naming its road to that road, not a nearer parallel one", async () => {
    // The A12 along lat 52.0, and a parallel N 11 ~28 m north of it.
    await seedSegment("444:f", 444, "LINESTRING(8.0 52.0, 8.1 52.0)");
    await sql`
      INSERT INTO conditions.road_segment
        (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
      VALUES ('445:f', 445, 'f', ST_SetSRID(ST_GeomFromText('LINESTRING(8.0 52.00025, 8.1 52.00025)'), 4326),
        'primary', 'N 11', 8000, 5, 80, ${NOW})`;
    // Each site lies ~22 m from the A12 and ~6 m from the N 11.
    const spot = point(8.05, 52.0002);
    for (const [site, roads] of [
      ["on-a12", [{ ref: "A 12" }]],
      ["on-other", [{ ref: "A 3" }]],
      ["unnamed", []],
    ] as const) {
      await seedSite(site, spot);
      if (roads.length > 0) await writeSiteFeature(sql, SRC, site, spot, roads, NOW);
    }
    await matchSensors(sql, () => NOW);
    const rows = await sql<{ subject_key: string; segment_id: string }[]>`
      SELECT subject_key, segment_id FROM conditions.sensor_segment
       WHERE segment_id IN ('444:f', '445:f') ORDER BY subject_key`;
    // A site naming a road neither segment carries snaps to neither.
    expect(rows).toEqual([
      { subject_key: siteKey(SRC, "on-a12"), segment_id: "444:f" },
      { subject_key: siteKey(SRC, "unnamed"), segment_id: "445:f" },
    ]);
  }, 30_000);

  it("snaps a site that states only a level of service", async () => {
    await seedSegment("333:f", 333, "LINESTRING(7.0 52.0, 7.1 52.0)");
    await seedFlowSource(sql, SRC);
    await writeSiteReadings(
      sql,
      SRC,
      [{ site: "los-only", geometry: point(7.05, 52.0001), at, los: "queuing" }],
      NOW,
    );
    await matchSensors(sql, () => NOW);
    const rows = await sql`SELECT subject_key FROM conditions.sensor_segment
      WHERE segment_id = '333:f'`;
    expect(rows).toEqual([{ subject_key: siteKey(SRC, "los-only") }]);
  }, 30_000);

  it("snaps only the site-level speed series of flow sources", async () => {
    await seedSegment("222:f", 222, "LINESTRING(6.0 52.0, 6.1 52.0)");
    // A lane channel of a site, beside the site's own series.
    await seedFlowSource(sql, SRC);
    await writeSiteReadings(
      sql,
      SRC,
      [{ site: "lanes", geometry: point(6.05, 52.0001), at, speed: 70, componentKey: "1" }],
      NOW,
    );
    // A source the catalogue does not list as a flow feed.
    await writeSiteReadings(
      sql,
      "not-a-flow-feed",
      [{ site: "x", geometry: point(6.05, 52.0001), at, speed: 70 }],
      NOW,
      { catalogued: false },
    );
    await matchSensors(sql, () => NOW);
    const rows = await sql`SELECT subject_key FROM conditions.sensor_segment
      WHERE segment_id = '222:f'`;
    expect(rows).toEqual([]);
  }, 30_000);
});
