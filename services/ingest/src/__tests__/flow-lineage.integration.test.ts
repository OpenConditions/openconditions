import { captureLicensing } from "@openconditions/ingest-framework";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fuseSegmentSpeed, propagateSegmentSpeed } from "../pipeline/segment-speed.js";

let db: TestDatabase;
let sql: postgres.Sql;
const NOW = "2026-01-01T00:00:00Z";
/** This fixture writer explicitly supplies each scalar's own source and captures at write.
 * Legacy inputs have no such assertion and deliberately never call this helper. */
async function captureWrittenScalars(segmentId: string, source: string) {
  await sql`
    UPDATE conditions.segment_observation o SET field_contributors = captured.fields,
      field_sources = conditions.flow_field_sources(captured.fields),
      native_field_sources = conditions.flow_native_field_sources(captured.fields, o.source)
    FROM (SELECT segment_id, source, jsonb_build_object(
      'speed', CASE WHEN current_kph IS NOT NULL THEN conditions.flow_credit(source) ELSE '[]'::jsonb END,
      'freeFlow', CASE WHEN free_flow_kph IS NOT NULL THEN conditions.flow_credit(source) ELSE '[]'::jsonb END,
      'ratio', CASE WHEN speed_ratio IS NOT NULL THEN conditions.flow_credit(source) ELSE '[]'::jsonb END,
      'los', CASE WHEN los <> 'unknown' THEN conditions.flow_credit(source) ELSE '[]'::jsonb END,
      'geometry', conditions.flow_osm_credit()) AS fields
      FROM conditions.segment_observation WHERE segment_id = ${segmentId} AND source = ${source}) captured
    WHERE o.segment_id = captured.segment_id AND o.source = captured.source`;
}
beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await syncSources(
    sql,
    ["parent-a", "child-a", "sensor-b", "los-c", "los-d"].map((id) => ({
      id,
      name: id === "parent-a" ? "Publisher A" : id,
      homepage: `https://example.org/${id}`,
      domain: "roads",
      format: "native",
      product: "flow",
      tier: "authoritative",
      operator: "Operator",
      license: "CC0-1.0",
      attribution: "Required credit",
      restricted: id === "sensor-b",
      cadenceSec: 60,
      freshnessWindowSec: 900,
      ...(id === "child-a" ? { parentSourceId: "parent-a", notice: "Verbatim notice" } : {}),
    })),
  );
  await sql`INSERT INTO conditions.road_segment
    (segment_id,way_id,dir,geom,highway,ref,length_m,min_zoom,free_flow_kph,computed_at)
    VALUES ('1:f',1,'f',ST_GeomFromText('LINESTRING(5.1 52.1,5.11 52.1)',4326),'motorway','A',1000,5,100,${NOW}),
    ('2:f',2,'f',ST_GeomFromText('LINESTRING(5.11 52.1,5.12 52.1)',4326),'motorway','A',1000,5,120,${NOW})`;
  await sql`INSERT INTO conditions.segment_observation
    (segment_id,source,source_tier,current_kph,free_flow_kph,speed_ratio,los,confidence,observed_at)
    VALUES ('1:f','child-a','authoritative',20,100,0.2,'queuing',1,${NOW}),
    ('1:f','sensor-b','sensor',80,100,0.8,'heavy',1,${NOW}),
    ('1:f','los-c','authoritative',NULL,NULL,NULL,'blocked',1,${NOW}),
    ('1:f','los-d','authoritative',NULL,NULL,NULL,'blocked',1,${NOW})`;
  for (const source of ["child-a", "sensor-b", "los-c", "los-d"])
    await captureWrittenScalars("1:f", source);
}, 120000);
afterAll(async () => {
  await db?.close();
});
it("captures only selected field suppliers, parent notices, and all native rights contributors", async () => {
  await fuseSegmentSpeed(sql, () => NOW);
  const [row] = await sql`SELECT * FROM conditions.segment_speed WHERE segment_id='1:f'`;
  expect(row!.current_kph).toBe(20);
  expect(row!.contributing.sort()).toEqual(["child-a", "los-c", "los-d", "sensor-b"]);
  expect(row!.field_sources).toEqual({
    speed: ["parent-a"],
    freeFlow: ["parent-a"],
    ratio: ["parent-a"],
    los: ["los-c", "los-d"],
    confidence: ["parent-a"],
    geometry: ["openstreetmap"],
  });
  expect(row!.native_field_sources.speed).toEqual(["child-a"]);
  expect(row!.field_contributors.speed).toContainEqual({
    sourceId: "parent-a",
    name: "Verbatim notice",
  });
  await sql`UPDATE conditions.source SET attribution='Later catalogue' WHERE id='parent-a'`;
  const [held] =
    await sql`SELECT field_contributors FROM conditions.segment_speed WHERE segment_id='1:f'`;
  expect(held!.field_contributors.speed[0].attributionText).toBe("Required credit");
});
it("propagates the speed receipt but recomputes ratio with target OSM free flow", async () => {
  await propagateSegmentSpeed(sql, () => NOW);
  const [row] = await sql`SELECT * FROM conditions.segment_speed WHERE segment_id='2:f'`;
  expect(row!.field_sources).toEqual({
    speed: ["parent-a"],
    freeFlow: ["openstreetmap"],
    ratio: ["openstreetmap", "parent-a"],
    los: ["openstreetmap", "parent-a"],
    confidence: ["openstreetmap", "parent-a"],
    geometry: ["openstreetmap"],
  });
  expect(row!.field_contributors.speed).toContainEqual({
    sourceId: "parent-a",
    name: "Verbatim notice",
  });
});

it("fallback LOS follows the speed snapshot and an unknown crowd source keeps its own proven identity", async () => {
  await sql`UPDATE conditions.segment_observation SET los='unknown' WHERE current_kph IS NULL`;
  await fuseSegmentSpeed(sql, () => NOW);
  const [row] =
    await sql`SELECT field_sources FROM conditions.segment_speed WHERE segment_id='1:f'`;
  expect(row!.field_sources.los).toEqual(["parent-a"]);
  expect(row!.field_sources.confidence).toEqual(["parent-a"]);
  await sql`INSERT INTO conditions.segment_observation
    (segment_id,source,source_tier,current_kph,free_flow_kph,speed_ratio,los,confidence,observed_at)
    VALUES ('2:f','crowd','crowd',60,120,0.5,'heavy',1,${NOW})`;
  await captureWrittenScalars("2:f", "crowd");
  await fuseSegmentSpeed(sql, () => NOW);
  const [crowd] =
    await sql`SELECT field_sources,field_contributors FROM conditions.segment_speed WHERE segment_id='2:f'`;
  expect(crowd!.field_sources.speed).toEqual(["crowd"]);
  expect(crowd!.field_contributors.speed).toEqual([{ sourceId: "crowd", name: "crowd" }]);
});

it("tracks native, OSM-enriched and graph-fallback sensor denominators from stored reading inputs", async () => {
  const { siteKey, writeSiteReadings } = await import("./helpers/flow-series.js");
  const { writeSensorObservations } = await import("../pipeline/segment-speed.js");
  for (const [id, baseline] of [
    [3, "native"],
    [4, "osm_maxspeed"],
    [5, "none"],
  ] as const) {
    await sql`INSERT INTO conditions.road_segment
      (segment_id,way_id,dir,geom,highway,length_m,min_zoom,free_flow_kph,computed_at)
      VALUES (${`${id}:f`},${id},'f',ST_GeomFromText('LINESTRING(5.1 52.1,5.11 52.1)',4326),'motorway',1000,5,100,${NOW})`;
    const source = `sensor-${id}`;
    await writeSiteReadings(
      sql,
      source,
      [
        {
          site: "s",
          geometry: { type: "Point", coordinates: [5.1, 52.1] },
          at: NOW,
          speed: 40,
          ...(baseline === "none"
            ? {}
            : { freeFlowKph: 90, baselineSource: baseline as "native" | "osm_maxspeed" }),
        },
      ],
      NOW,
    );
    await sql`INSERT INTO conditions.sensor_segment(subject_key,segment_id,fraction,offset_m,matched_at)
      VALUES (${siteKey(source, "s")},${`${id}:f`},0.5,0,${NOW})`;
  }
  await writeSensorObservations(sql, () => NOW);
  await fuseSegmentSpeed(sql, () => NOW);
  const rows =
    await sql`SELECT segment_id,field_sources,native_field_sources FROM conditions.segment_speed WHERE segment_id IN ('3:f','4:f','5:f') ORDER BY segment_id`;
  expect(rows[0]!.field_sources.freeFlow).toEqual(["sensor-3"]);
  for (const row of rows.slice(1)) {
    expect(row.field_sources.freeFlow).toEqual(["openstreetmap"]);
    expect(row.field_sources.ratio).toEqual(["openstreetmap", `sensor-${row.segment_id[0]}`]);
    expect(row.native_field_sources.freeFlow).toEqual(["openstreetmap"]);
  }
});

it("GeoJSON and decoded MVT expose matching receipts and withhold restricted legacy/new speeds", async () => {
  const { mvtProperties } = await import("./helpers/mvt-properties.js");
  const { registerPublishRoutes } = await import("../publish-routes.js");
  const { FeedStatusStore } = await import("../feed-status.js");
  const { REPO_CATALOG } = await import("./helpers/catalog.js");
  const { default: Fastify } = await import("fastify");
  const app = Fastify();
  registerPublishRoutes(app, sql, new FeedStatusStore(), REPO_CATALOG);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/segments.geojson?bbox=5,52,5.2,52.2",
    });
    const geo = response
      .json()
      .features.map((f: { properties: Record<string, unknown> }) => f.properties);
    const [tile] = await sql`SELECT conditions.segment_flow(8,131,84,'{}'::json) AS mvt`;
    const mvt = mvtProperties(tile!.mvt);
    for (const segment of ["1:f", "3:f", "4:f", "5:f"]) {
      const g = geo.find((f: Record<string, unknown>) => f.segment_id === segment)!;
      const t = mvt.find((f) => f.segment_id === segment)!;
      expect(JSON.parse(t.field_sources as string)).toEqual(g.field_sources);
      expect(JSON.parse(t.field_contributors as string)).toEqual(g.field_contributors);
      expect(JSON.parse(t.field_lineage_complete as string)).toEqual(g.field_lineage_complete);
      if (segment === "1:f") {
        expect(t.current_kph).toBeUndefined();
        expect(g.current_kph).toBeUndefined();
        expect(g.field_sources).toEqual({ geometry: ["openstreetmap"] });
      }
    }
    // Legacy row remains valid internally, without falsely exact measurement lineage.
    await sql`UPDATE conditions.segment_speed SET field_sources=NULL,field_contributors=NULL WHERE segment_id='1:f'`;
    const [legacy] = await sql`SELECT conditions.segment_flow(8,131,84,'{}'::json) AS mvt`;
    const held = mvtProperties(legacy!.mvt).find((f) => f.segment_id === "1:f")!;
    expect(held.current_kph).toBeUndefined();
    expect(JSON.parse(held.field_sources as string)).toEqual({ geometry: ["openstreetmap"] });
    // Public routing continues to withhold by all live contributing IDs, including losing speeds.
    const csv = await app.inject({ method: "GET", url: "/segments/speed.csv?bbox=5,52,5.2,52.2" });
    expect(csv.body).not.toContain("1,f,20");
  } finally {
    await app.close();
  }
});

it("keeps sensor receipts immutable while the selected measurement is unchanged", async () => {
  const { writeSensorObservations } = await import("../pipeline/segment-speed.js");
  const [original] =
    await sql`SELECT field_contributors FROM conditions.segment_observation WHERE segment_id='3:f'`;
  await sql`UPDATE conditions.source SET attribution='Updated metadata' WHERE id='sensor-3'`;
  await writeSensorObservations(sql, () => NOW);
  const [same] =
    await sql`SELECT field_contributors FROM conditions.segment_observation WHERE segment_id='3:f'`;
  expect(same!.field_contributors).toEqual(original!.field_contributors);
});

it("preserves legacy speed values while omitting unproven propagated ratio and LOS receipts", async () => {
  const { writeSensorObservations } = await import("../pipeline/segment-speed.js");
  await sql`UPDATE conditions.segment_speed SET field_sources=NULL,field_contributors=NULL,native_field_sources=NULL WHERE segment_id='1:f'`;
  await sql`INSERT INTO conditions.road_segment
    (segment_id,way_id,dir,geom,highway,ref,length_m,min_zoom,free_flow_kph,computed_at)
    VALUES ('6:f',6,'f',ST_GeomFromText('LINESTRING(5.11 52.1,5.115 52.1)',4326),'motorway','A',1000,5,120,${NOW})`;
  await propagateSegmentSpeed(sql, () => NOW);
  const [row] =
    await sql`SELECT current_kph,speed_ratio,field_sources FROM conditions.segment_speed WHERE segment_id='6:f'`;
  expect(row!.current_kph).toBe(20);
  expect(row!.speed_ratio).toBeCloseTo(20 / 120);
  expect(row!.field_sources).toEqual({
    geometry: ["openstreetmap"],
    freeFlow: ["openstreetmap"],
    ratio: ["openstreetmap"],
    los: ["openstreetmap"],
    confidence: ["openstreetmap"],
  });
  // An unchanged legacy sensor row is repaired at the next normal write, without dropping values.
  await sql`UPDATE conditions.segment_observation SET native_field_sources=NULL,field_sources=NULL,field_contributors=NULL WHERE segment_id='3:f'`;
  await writeSensorObservations(sql, () => NOW);
  const [repaired] =
    await sql`SELECT current_kph,field_sources FROM conditions.segment_observation WHERE segment_id='3:f'`;
  expect(repaired!.current_kph).toBe(40);
  expect(repaired!.field_sources.ratio).toEqual(["sensor-3"]);
});

it("refreshes captured rights when the actual selected input provenance changes at the same measured value", async () => {
  const { writeSensorObservations } = await import("../pipeline/segment-speed.js");
  const { writeSiteReadings } = await import("./helpers/flow-series.js");
  await writeSiteReadings(
    sql,
    "sensor-3",
    [
      {
        site: "s",
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        at: NOW,
        speed: 40,
        freeFlowKph: 90,
        attribution: {
          provider: "Test",
          license: "CC-BY-4.0",
          licensing: captureLicensing({
            id: "sensor-3",
            name: "Selected sensor measurements",
            license: "CC-BY-4.0",
          }),
        },
      },
    ],
    NOW,
  );
  await writeSensorObservations(sql, () => NOW);
  const [row] =
    await sql`SELECT field_contributors FROM conditions.segment_observation WHERE segment_id='3:f'`;
  expect(row!.field_contributors.speed[0].licensing).toEqual(
    captureLicensing({
      id: "sensor-3",
      name: "Selected sensor measurements",
      license: "CC-BY-4.0",
    }),
  );
});

it("retains native child identity for every sensor field while publishing canonical parent credits", async () => {
  const { siteKey, writeSiteReadings } = await import("./helpers/flow-series.js");
  const { writeSensorObservations } = await import("../pipeline/segment-speed.js");
  await sql`INSERT INTO conditions.road_segment
    (segment_id,way_id,dir,geom,highway,length_m,min_zoom,free_flow_kph,computed_at)
    VALUES ('7:f',7,'f',ST_GeomFromText('LINESTRING(5.1 52.1,5.11 52.1)',4326),'motorway',1000,5,100,${NOW})`;
  await writeSiteReadings(
    sql,
    "child-a",
    [
      {
        site: "parent-sensor",
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        at: NOW,
        speed: 50,
        freeFlowKph: 100,
      },
    ],
    NOW,
  );
  await sql`INSERT INTO conditions.sensor_segment(subject_key,segment_id,fraction,offset_m,matched_at)
    VALUES (${siteKey("child-a", "parent-sensor")},'7:f',0.5,0,${NOW})`;
  await writeSensorObservations(sql, () => NOW);
  const [row] =
    await sql`SELECT native_field_sources,field_sources,field_contributors FROM conditions.segment_observation WHERE segment_id='7:f'`;
  expect(row!.native_field_sources).toEqual({
    speed: ["child-a"],
    freeFlow: ["child-a"],
    ratio: ["child-a"],
    los: ["child-a"],
    geometry: ["openstreetmap"],
  });
  expect(row!.field_sources.speed).toEqual(["parent-a"]);
  expect(row!.field_contributors.speed).toContainEqual({
    sourceId: "parent-a",
    name: "Verbatim notice",
  });
});

it("uses a new direct writer snapshot when that selected measurement changes", async () => {
  await sql`UPDATE conditions.segment_observation SET current_kph=25,speed_ratio=0.25,observed_at='2026-01-01T00:01:00Z' WHERE segment_id='1:f' AND source='child-a'`;
  await captureWrittenScalars("1:f", "child-a");
  await fuseSegmentSpeed(sql, () => "2026-01-01T00:01:00Z");
  const [row] =
    await sql`SELECT current_kph,field_contributors FROM conditions.segment_speed WHERE segment_id='1:f'`;
  expect(row!.current_kph).toBe(25);
  expect(row!.field_contributors.speed).toContainEqual(
    expect.objectContaining({ attributionText: "Later catalogue" }),
  );
});

it("declared-only measured confidence credits the worst LOS ties and propagated confidence does not require a denominator", async () => {
  await sql`UPDATE conditions.segment_observation SET current_kph=NULL,free_flow_kph=NULL,speed_ratio=NULL,los='unknown' WHERE segment_id='1:f' AND source='child-a'`;
  await sql`UPDATE conditions.segment_observation SET current_kph=NULL,free_flow_kph=NULL,speed_ratio=NULL,los='blocked' WHERE segment_id='1:f' AND source IN ('los-c','los-d')`;
  await sql`DELETE FROM conditions.segment_observation WHERE segment_id='1:f' AND source='sensor-b'`;
  for (const source of ["child-a", "los-c", "los-d"]) await captureWrittenScalars("1:f", source);
  await fuseSegmentSpeed(sql, () => NOW);
  const [declared] =
    await sql`SELECT confidence,field_sources FROM conditions.segment_speed WHERE segment_id='1:f'`;
  expect(declared!.confidence).toBe("measured");
  expect(declared!.field_sources.confidence).toEqual(["los-c", "los-d"]);
  await sql`UPDATE conditions.road_segment SET ref='confidence' WHERE segment_id='7:f'`;
  await sql`INSERT INTO conditions.road_segment
    (segment_id,way_id,dir,geom,highway,ref,length_m,min_zoom,free_flow_kph,computed_at)
    VALUES ('8:f',8,'f',ST_GeomFromText('LINESTRING(5.11 52.1,5.12 52.1)',4326),'motorway','confidence',1000,5,NULL,${NOW})`;
  await propagateSegmentSpeed(sql, () => NOW);
  const [estimated] =
    await sql`SELECT confidence,speed_ratio,field_sources FROM conditions.segment_speed WHERE segment_id='8:f'`;
  expect(estimated!.confidence).toBe("estimated");
  expect(estimated!.speed_ratio).toBeNull();
  expect(estimated!.field_sources.confidence).toEqual(["openstreetmap", "parent-a"]);
});

it("does not invent precise lineage for a legacy raw non-sensor observation during fusion or propagation", async () => {
  await sql`INSERT INTO conditions.road_segment
    (segment_id,way_id,dir,geom,highway,ref,length_m,min_zoom,free_flow_kph,computed_at)
    VALUES ('9:f',9,'f',ST_GeomFromText('LINESTRING(5.2 52.1,5.21 52.1)',4326),'motorway','legacy',1000,5,100,${NOW}),
    ('10:f',10,'f',ST_GeomFromText('LINESTRING(5.21 52.1,5.22 52.1)',4326),'motorway','legacy',1000,5,120,${NOW})`;
  await sql`INSERT INTO conditions.segment_observation
    (segment_id,source,source_tier,current_kph,free_flow_kph,speed_ratio,los,confidence,observed_at)
    VALUES ('9:f','child-a','authoritative',40,100,0.4,'queuing',1,${NOW})`;
  await fuseSegmentSpeed(sql, () => NOW);
  const [measured] =
    await sql`SELECT current_kph,speed_ratio,contributing,field_sources FROM conditions.segment_speed WHERE segment_id='9:f'`;
  expect(measured!.current_kph).toBe(40);
  expect(measured!.speed_ratio).toBe(0.4);
  expect(measured!.contributing).toEqual(["child-a"]);
  expect(measured!.field_sources).toEqual({ geometry: ["openstreetmap"] });
  await propagateSegmentSpeed(sql, () => NOW);
  const [estimated] =
    await sql`SELECT current_kph,field_sources FROM conditions.segment_speed WHERE segment_id='10:f'`;
  expect(estimated!.current_kph).toBe(40);
  expect(estimated!.field_sources).toEqual({
    geometry: ["openstreetmap"],
    freeFlow: ["openstreetmap"],
    ratio: ["openstreetmap"],
    los: ["openstreetmap"],
    confidence: ["openstreetmap"],
  });
});

it("keeps an unchanged speed receipt when a LOS heartbeat or independent LOS value changes", async () => {
  const { writeSensorObservations } = await import("../pipeline/segment-speed.js");
  const { writeSiteReadings } = await import("./helpers/flow-series.js");
  await writeSiteReadings(
    sql,
    "child-a",
    [
      {
        site: "parent-sensor",
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        at: NOW,
        los: "heavy",
      },
    ],
    NOW,
  );
  await writeSensorObservations(sql, () => NOW);
  const [before] =
    await sql`SELECT field_contributors FROM conditions.segment_observation WHERE segment_id='7:f'`;
  await sql`UPDATE conditions.source SET attribution='Heartbeat catalog change' WHERE id='parent-a'`;
  await sql`INSERT INTO conditions.source_status(source,last_success_at,freshness_window_sec) VALUES ('child-a','2026-01-01T00:01:00Z',900)
    ON CONFLICT(source) DO UPDATE SET last_success_at=EXCLUDED.last_success_at`;
  await writeSensorObservations(sql, () => "2026-01-01T00:01:00Z");
  const [after] =
    await sql`SELECT observed_at,field_contributors FROM conditions.segment_observation WHERE segment_id='7:f'`;
  expect(after!.observed_at.toISOString()).toBe("2026-01-01T00:01:00.000Z");
  expect(after!.field_contributors.speed).toEqual(before!.field_contributors.speed);
  await writeSiteReadings(
    sql,
    "child-a",
    [
      {
        site: "parent-sensor",
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        at: "2026-01-01T00:02:00Z",
        los: "blocked",
      },
    ],
    "2026-01-01T00:02:00Z",
  );
  await writeSensorObservations(sql, () => "2026-01-01T00:02:00Z");
  const [changedLos] =
    await sql`SELECT field_contributors FROM conditions.segment_observation WHERE segment_id='7:f'`;
  expect(changedLos!.field_contributors.speed).toEqual(before!.field_contributors.speed);
});

it("composes a changed ratio from the preserved numerator receipt and the new denominator receipt", async () => {
  const { siteKey, writeSiteReadings } = await import("./helpers/flow-series.js");
  const { writeSensorObservations } = await import("../pipeline/segment-speed.js");
  const [before] =
    await sql`SELECT field_contributors FROM conditions.segment_observation WHERE segment_id='7:f'`;
  await writeSiteReadings(
    sql,
    "child-a",
    [
      {
        site: "declared-extra",
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        at: "2026-01-01T00:02:00Z",
        los: "blocked",
      },
    ],
    "2026-01-01T00:02:00Z",
  );
  await sql`INSERT INTO conditions.sensor_segment(subject_key,segment_id,fraction,offset_m,matched_at)
    VALUES (${siteKey("child-a", "declared-extra")},'7:f',0.5,0,${NOW})`;
  await writeSensorObservations(sql, () => "2026-01-01T00:02:00Z");
  const [after] =
    await sql`SELECT field_contributors FROM conditions.segment_observation WHERE segment_id='7:f'`;
  expect(after!.field_contributors.speed).toEqual(before!.field_contributors.speed);
  for (const credit of before!.field_contributors.speed)
    expect(after!.field_contributors.ratio).toContainEqual(credit);
  expect(after!.field_contributors.ratio).toContainEqual(
    expect.objectContaining({ sourceId: "openstreetmap" }),
  );
});
