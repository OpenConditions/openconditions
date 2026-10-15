import { readGrid, recordOf } from "@openconditions/core";
import { type SourceEntry, syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  fuseSegmentSpeed,
  propagateSegmentSpeed,
  writeSensorObservations,
} from "../pipeline/segment-speed.js";
import { siteKey, writeSiteReadings } from "./helpers/flow-series.js";

let db: TestDatabase;
let sql: postgres.Sql;
const NOW = "2026-01-01T00:00:00Z";
const LATER = "2026-01-01T00:01:00Z";
const source = (
  id: string,
  name: string,
  notice: string,
  parentSourceId?: string,
): SourceEntry => ({
  id,
  name,
  notice,
  ...(parentSourceId ? { parentSourceId } : {}),
  domain: "roads",
  format: "datex2-measured",
  product: "flow",
  tier: "authoritative",
  operator: name,
  license: "CC0-1.0",
  attribution: name,
  restricted: false,
  cadenceSec: 60,
  freshnessWindowSec: 900,
});
beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120000);
afterAll(async () => {
  await db?.close();
}, 30000);
beforeEach(async () => {
  await sql`TRUNCATE conditions.segment_speed,conditions.segment_observation,conditions.sensor_segment,conditions.road_segment,conditions.observation_latest,conditions.source,conditions.source_status CASCADE`;
  await syncSources(sql, [
    source("parent-a", "Old publisher", "Old parent notice"),
    source("parent-b", "Other publisher", "Other parent notice"),
    source("child-a", "Child", "Old child notice", "parent-a"),
  ]);
  await sql`INSERT INTO conditions.road_segment(segment_id,way_id,dir,geom,highway,ref,length_m,min_zoom,free_flow_kph,computed_at)
    VALUES ('21:f',21,'f',ST_GeomFromText('LINESTRING(5.1 52.1,5.11 52.1)',4326),'motorway','receipts',1000,5,100,${NOW}),
    ('22:f',22,'f',ST_GeomFromText('LINESTRING(5.11 52.1,5.12 52.1)',4326),'motorway','receipts',1000,5,120,${NOW})`;
});
async function acquire(readings: { site: string; speed: number; at: string }[]) {
  await writeSiteReadings(
    sql,
    "child-a",
    readings.map((r) => ({
      ...r,
      freeFlowKph: 100,
      geometry: { type: "Point" as const, coordinates: [5.1, 52.1] },
    })),
    readings.at(-1)!.at,
  );
  for (const r of readings)
    await sql`INSERT INTO conditions.sensor_segment(subject_key,segment_id,fraction,offset_m,matched_at)
    VALUES (${siteKey("child-a", r.site)},'21:f',0.5,0,${r.at}) ON CONFLICT(subject_key) DO NOTHING`;
}
async function changedCatalogue() {
  await sql`UPDATE conditions.source SET credit_name='New publisher',credit_notice='New parent notice',attribution='New credit' WHERE id='parent-a'`;
  await sql`UPDATE conditions.source SET credit_notice='New child notice' WHERE id='child-a'`;
}
it("publishes captured scoped definitions independently of current catalogue policy", async () => {
  const licensing = {
    version: 1,
    declarations: [{ text: "Exact supplied terms" }],
    bindings: [
      {
        scope: "data",
        subject: "Selected measurements",
        license: {
          kind: "custom",
          namespace: "publisher:captured",
          id: "LicenseRef-Captured-Terms",
          name: "Captured measurement terms",
          url: "https://example.test/terms",
        },
        notice: "Required author credit",
        conditions: ["Keep measurement date"],
      },
    ],
  };
  const supplied = {
    provider: "Captured publisher",
    name: "Captured dataset",
    licensing,
    parentSourceId: "parent-a",
  };
  await sql`UPDATE conditions.source SET license='NOASSERTION',operator='New operator' WHERE id='parent-a'`;
  const [row] =
    await sql`SELECT conditions.flow_credit('child-a',${sql.json(supplied)}) AS credits, conditions.flow_osm_credit() AS osm`;
  expect(row!.credits).toContainEqual(
    expect.objectContaining({ sourceId: "parent-a", name: "Captured dataset", licensing }),
  );
  for (const credit of row!.credits) {
    expect(credit).not.toHaveProperty("spdxLicense");
    expect(credit).not.toHaveProperty("licenseUrl");
  }
  expect(row!.osm).toContainEqual(
    expect.objectContaining({
      licensing: {
        version: 1,
        bindings: [
          {
            scope: "data",
            subject: "OpenStreetMap",
            license: { kind: "spdx", expression: "ODbL-1.0" },
          },
        ],
      },
    }),
  );
});
it("honors the captured parent and excludes unrelated current-parent notices", async () => {
  await sql`UPDATE conditions.source SET parent_source_id='parent-b',credit_notice='Other child notice' WHERE id='child-a'`;
  const [row] =
    await sql`SELECT conditions.flow_credit('child-a','{"provider":"Captured publisher","license":"CC0-1.0","parentSourceId":"parent-a"}'::jsonb) AS credits`;
  expect(row!.credits).toContainEqual(
    expect.objectContaining({ sourceId: "parent-a", name: "Old publisher" }),
  );
  expect(row!.credits).toContainEqual({ sourceId: "parent-a", name: "Old parent notice" });
  expect(row!.credits.every((credit: { sourceId: string }) => credit.sourceId === "parent-a")).toBe(
    true,
  );
  expect(
    row!.credits.some((credit: { name: string }) => credit.name === "Other child notice"),
  ).toBe(false);
});
it("retains each acquired input receipt when only one of two sensor readings changes", async () => {
  await acquire([
    { site: "a", speed: 40, at: NOW },
    { site: "b", speed: 60, at: NOW },
  ]);
  const [original] =
    await sql`SELECT template,reading FROM conditions.observation_latest WHERE subject_key=${siteKey("child-a", "a")}`;
  const body = recordOf(original!.template, original!.reading);
  await writeSensorObservations(sql, () => NOW);
  await changedCatalogue();
  await acquire([{ site: "b", speed: 80, at: LATER }]);
  await writeSensorObservations(sql, () => LATER);
  await fuseSegmentSpeed(sql, () => LATER);
  await propagateSegmentSpeed(sql, () => LATER);
  const [measured] = await sql`SELECT * FROM conditions.segment_speed WHERE segment_id='21:f'`;
  expect(measured!.current_kph).toBe(60);
  expect(measured!.contributing).toEqual(["child-a"]);
  expect(measured!.field_lineage_complete.speed).toBe(true);
  expect(measured!.field_lineage_complete.ratio).toBe(true);
  for (const name of [
    "Old publisher",
    "New publisher",
    "Old parent notice",
    "New parent notice",
    "Old child notice",
    "New child notice",
  ]) {
    expect(measured!.field_contributors.speed).toContainEqual(
      expect.objectContaining({ sourceId: "parent-a", name }),
    );
  }
  const [estimated] =
    await sql`SELECT field_contributors FROM conditions.segment_speed WHERE segment_id='22:f'`;
  expect(estimated!.field_contributors.speed).toEqual(measured!.field_contributors.speed);
  const [held] =
    await sql`SELECT template,reading FROM conditions.observation_latest WHERE subject_key=${siteKey("child-a", "a")}`;
  expect(recordOf(held!.template, held!.reading)).toEqual(body);
});
it("does not invent a receipt for an unchanged legacy input when a neighbor changes", async () => {
  await acquire([
    { site: "a", speed: 40, at: NOW },
    { site: "b", speed: 60, at: NOW },
  ]);
  // Null the new optional acquisition column only if present: this represents an upgraded historical raw row.
  await sql`DO $$ BEGIN IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='conditions' AND table_name='observation_latest' AND column_name='contributor_receipt_id') THEN
    EXECUTE 'UPDATE conditions.observation_latest SET contributor_receipt_id=NULL WHERE subject_key=''feature:oc:feature:child-a:a'''; END IF; END $$`;
  await changedCatalogue();
  await acquire([{ site: "b", speed: 80, at: LATER }]);
  await writeSensorObservations(sql, () => LATER);
  await fuseSegmentSpeed(sql, () => LATER);
  const [row] =
    await sql`SELECT current_kph,field_sources,field_contributors,field_lineage_complete FROM conditions.segment_speed WHERE segment_id='21:f'`;
  expect(row!.current_kph).toBe(60);
  expect(row!.field_sources.speed).toEqual(["parent-a"]);
  expect(row!.field_contributors.speed).toContainEqual(
    expect.objectContaining({ name: "New publisher" }),
  );
  expect(
    row!.field_contributors.speed.some((c: { name: string }) => c.name === "Old publisher"),
  ).toBe(false);
  expect(row!.field_lineage_complete.speed).toBe(false);
  expect(row!.field_lineage_complete.ratio).toBe(false);
});
it("grid reads preserve acquired old credits after catalogue reparenting", async () => {
  await acquire([{ site: "a", speed: 40, at: NOW }]);
  await sql`UPDATE conditions.source SET parent_source_id='parent-b',credit_notice='Other child notice' WHERE id='child-a'`;
  const grid = await readGrid(
    { execute: (q, p) => sql.unsafe(q, p as never) as never },
    {
      scope: "public",
      property: "traffic.speed",
      bbox: [5, 52, 5.2, 52.2],
      cellDeg: 1,
      since: new Date(NOW),
      at: new Date(LATER),
    },
  );
  expect(grid.cells).toEqual([[5.5, 52.5, 1, 40, 40]]);
  expect(grid.cell_contributors[0]!.contributors).toContainEqual(
    expect.objectContaining({ sourceId: "parent-a", name: "Old publisher" }),
  );
  expect(grid.cell_contributors[0]!.contributors).toContainEqual({
    sourceId: "parent-a",
    name: "Old parent notice",
  });
});

it("keeps acquired pointers and legacy nulls stable through identical polls and catalogue-only changes", async () => {
  await acquire([
    { site: "a", speed: 40, at: NOW },
    { site: "b", speed: 60, at: NOW },
  ]);
  const [known] =
    await sql`SELECT contributor_receipt_id FROM conditions.observation_latest WHERE subject_key=${siteKey("child-a", "b")}`;
  await sql`UPDATE conditions.observation_latest SET contributor_receipt_id=NULL WHERE subject_key=${siteKey("child-a", "a")}`;
  await changedCatalogue();
  await acquire([
    { site: "a", speed: 40, at: NOW },
    { site: "b", speed: 60, at: NOW },
  ]);
  await writeSensorObservations(sql, () => LATER);
  const rows =
    await sql`SELECT subject_key,contributor_receipt_id FROM conditions.observation_latest ORDER BY subject_key`;
  expect(rows[0]!.contributor_receipt_id).toBeNull();
  expect(rows[1]!.contributor_receipt_id).toBe(known!.contributor_receipt_id);
  const grid = await readGrid(
    { execute: (q, p) => sql.unsafe(q, p as never) as never },
    {
      scope: "public",
      property: "traffic.speed",
      bbox: [5, 52, 5.2, 52.2],
      cellDeg: 1,
      since: new Date(NOW),
      at: new Date(LATER),
    },
  );
  expect(grid.cells).toEqual([[5.5, 52.5, 2, 100, 60]]);
  expect(grid.cell_contributors[0]).toMatchObject({
    native_sources: ["child-a"],
    sources: ["parent-a"],
    lineage_complete: false,
  });
  expect(grid.cell_contributors[0]!.contributors).toContainEqual(
    expect.objectContaining({ name: "Old publisher" }),
  );
  await sql`UPDATE conditions.observation_latest SET contributor_receipt_id=NULL`;
  const unknown = await readGrid(
    { execute: (q, p) => sql.unsafe(q, p as never) as never },
    {
      scope: "public",
      property: "traffic.speed",
      bbox: [5, 52, 5.2, 52.2],
      cellDeg: 1,
      since: new Date(NOW),
      at: new Date(LATER),
    },
  );
  expect(unknown.cell_contributors).toEqual([
    { longitude: 5.5, latitude: 52.5, native_sources: ["child-a"], lineage_complete: false },
  ]);
});
it("keeps exact native children separate even when their canonical parent is the same", async () => {
  await syncSources(sql, [
    source("parent-a", "Old publisher", "Old parent notice"),
    source("child-a", "Child", "Old child notice", "parent-a"),
    source("child-b", "Other child", "B notice", "parent-a"),
  ]);
  await acquire([{ site: "a", speed: 40, at: NOW }]);
  await writeSiteReadings(
    sql,
    "child-b",
    [{ site: "b", speed: 80, at: NOW, geometry: { type: "Point", coordinates: [6.1, 52.1] } }],
    NOW,
  );
  const grid = await readGrid(
    { execute: (q, p) => sql.unsafe(q, p as never) as never },
    {
      scope: "public",
      property: "traffic.speed",
      bbox: [5, 52, 7, 53],
      cellDeg: 1,
      since: new Date(NOW),
      at: new Date(LATER),
    },
  );
  expect(
    grid.cell_contributors.map((c) => ({ native_sources: c.native_sources, sources: c.sources })),
  ).toEqual([
    { native_sources: ["child-a"], sources: ["parent-a"] },
    { native_sources: ["child-b"], sources: ["parent-a"] },
  ]);
});

it("captures a first legacy receipt only when the writer receives explicit fresh acquisition evidence", async () => {
  await acquire([{ site: "a", speed: 40, at: NOW }]);
  await sql`UPDATE conditions.observation_latest SET contributor_receipt_id=NULL`;
  await changedCatalogue();
  await sql`INSERT INTO conditions.source_status(source,last_success_at,freshness_window_sec) VALUES ('child-a',${LATER},900)`;
  await writeSensorObservations(sql, () => LATER);
  const [unknown] =
    await sql`SELECT field_contributors,field_lineage_complete FROM conditions.segment_observation WHERE segment_id='21:f'`;
  expect(unknown!.field_contributors.speed).toBeUndefined();
  expect(unknown!.field_lineage_complete.speed).toBe(false);
  await writeSiteReadings(
    sql,
    "child-a",
    [
      {
        site: "a",
        speed: 40,
        freeFlowKph: 100,
        at: NOW,
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
      },
    ],
    LATER,
    { captureEvidence: "acquired" },
  );
  await writeSensorObservations(sql, () => LATER);
  const [known] =
    await sql`SELECT field_contributors,field_lineage_complete FROM conditions.segment_observation WHERE segment_id='21:f'`;
  expect(known!.field_contributors.speed).toContainEqual(
    expect.objectContaining({ name: "New publisher" }),
  );
  expect(known!.field_lineage_complete.speed).toBe(true);
});

it("retains known worst-LOS tie receipts and confidence when another selected LOS input is historically unknown", async () => {
  await writeSiteReadings(
    sql,
    "child-a",
    [
      { site: "a", los: "blocked", at: NOW, geometry: { type: "Point", coordinates: [5.1, 52.1] } },
      { site: "b", los: "blocked", at: NOW, geometry: { type: "Point", coordinates: [5.1, 52.1] } },
    ],
    NOW,
  );
  for (const site of ["a", "b"])
    await sql`INSERT INTO conditions.sensor_segment(subject_key,segment_id,fraction,offset_m,matched_at) VALUES (${siteKey("child-a", site)},'21:f',0.5,0,${NOW})`;
  await sql`UPDATE conditions.observation_latest SET contributor_receipt_id=NULL WHERE subject_key=${siteKey("child-a", "a")}`;
  await writeSensorObservations(sql, () => NOW);
  await fuseSegmentSpeed(sql, () => NOW);
  const [row] =
    await sql`SELECT los,confidence,field_sources,field_contributors,field_lineage_complete FROM conditions.segment_speed WHERE segment_id='21:f'`;
  expect(row!.los).toBe("blocked");
  expect(row!.confidence).toBe("measured");
  expect(row!.field_sources.los).toEqual(["parent-a"]);
  expect(row!.field_contributors.los).toContainEqual({
    sourceId: "parent-a",
    name: "Old child notice",
  });
  expect(row!.field_contributors.confidence).toEqual(row!.field_contributors.los);
  expect(row!.field_lineage_complete.los).toBe(false);
  expect(row!.field_lineage_complete.confidence).toBe(false);
});
