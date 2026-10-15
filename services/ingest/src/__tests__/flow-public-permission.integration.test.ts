import { CONTRIBUTOR_RECEIPT_VERSION } from "@openconditions/core";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { registerScope } from "../api/scope.js";
import { FeedStatusStore } from "../feed-status.js";
import {
  fuseSegmentSpeed,
  propagateSegmentSpeed,
  writeSensorObservations,
} from "../pipeline/segment-speed.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { REPO_CATALOG } from "./helpers/catalog.js";
import { siteKey, writeSiteReadings } from "./helpers/flow-series.js";
import { mvtProperties } from "./helpers/mvt-properties.js";

let db: TestDatabase;
let sql: postgres.Sql;
const NOW = "2026-01-01T00:00:00Z";
const TOKEN = "operator-token-for-flow-permission-tests-0123456789";
beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120000);
beforeEach(async () => {
  await sql`TRUNCATE conditions.segment_speed,conditions.segment_observation,conditions.sensor_segment,conditions.road_segment,conditions.observation_latest CASCADE`;
  await syncSources(sql, [
    {
      id: "native",
      domain: "roads",
      format: "native",
      product: "flow",
      tier: "authoritative",
      operator: "Native",
      license: "CC0-1.0",
      attribution: "Native",
      restricted: false,
      cadenceSec: 60,
      freshnessWindowSec: 900,
    },
  ]);
  await sql`INSERT INTO conditions.road_segment(segment_id,way_id,dir,geom,highway,ref,length_m,min_zoom,free_flow_kph,computed_at)
    VALUES ('1:f',1,'f',ST_GeomFromText('LINESTRING(5.1 52.1,5.11 52.1)',4326),'motorway','A',1000,5,100,${NOW}),
    ('2:f',2,'f',ST_GeomFromText('LINESTRING(5.11 52.1,5.12 52.1)',4326),'motorway','A',1000,5,100,${NOW})`;
});
afterAll(async () => {
  await db?.close();
});

it("withholds captured restricted upstream speed and its propagated estimate from every public flow surface", async () => {
  await writeSiteReadings(
    sql,
    "native",
    [
      {
        site: "a",
        speed: 40,
        at: NOW,
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        upstream: [{ publisher: "Restricted authority", license: "ODbL-1.0" }],
      },
    ],
    NOW,
  );
  await sql`INSERT INTO conditions.sensor_segment(subject_key,segment_id,fraction,offset_m,matched_at) VALUES (${siteKey("native", "a")},'1:f',0.5,0,${NOW})`;
  await writeSensorObservations(sql, () => NOW);
  await fuseSegmentSpeed(sql, () => NOW);
  await propagateSegmentSpeed(sql, () => NOW);
  const app = Fastify();
  registerScope(app, TOKEN);
  registerPublishRoutes(app, sql, new FeedStatusStore(), REPO_CATALOG);
  try {
    const publicGeo = (await app.inject("/segments.geojson?bbox=5,52,5.2,52.2")).json();
    expect(publicGeo.features).toHaveLength(2);
    for (const feature of publicGeo.features)
      expect(feature.properties.current_kph).toBeUndefined();
    const csv = await app.inject("/segments/speed.csv?bbox=5,52,5.2,52.2");
    expect(csv.body).not.toContain(",40");
    const [tile] = await sql`SELECT conditions.segment_flow(8,131,84,'{}'::json) AS mvt`;
    for (const feature of mvtProperties(tile!.mvt)) expect(feature.current_kph).toBeUndefined();
    const operatorGeo = (
      await app.inject({
        url: "/segments.geojson?bbox=5,52,5.2,52.2",
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json();
    expect(
      operatorGeo.features.map(
        (f: { properties: { current_kph: number } }) => f.properties.current_kph,
      ),
    ).toEqual([40, 40]);
  } finally {
    await app.close();
  }
});

it("uses exact acquired permission IDs and reevaluates the current classifier without catalogue credit inference", async () => {
  await writeSiteReadings(
    sql,
    "native",
    [
      {
        site: "a",
        speed: 40,
        at: NOW,
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        upstream: [
          { publisher: "Authority", license: "CC-BY-4.0" },
          { publisher: "Relay without independent terms" },
        ],
      },
    ],
    NOW,
  );
  await sql`INSERT INTO conditions.sensor_segment(subject_key,segment_id,fraction,offset_m,matched_at) VALUES (${siteKey("native", "a")},'1:f',0.5,0,${NOW})`;
  // Later template metadata is not evidence for the acquired measurement.
  await sql`UPDATE conditions.observation_latest SET template=jsonb_set(template,'{provenance,upstream}','[{"publisher":"Later metadata","license":"ODbL-1.0"}]'::jsonb)`;
  await writeSensorObservations(sql, () => NOW);
  await fuseSegmentSpeed(sql, () => NOW);
  await propagateSegmentSpeed(sql, () => NOW);
  const held =
    await sql`SELECT permission_licenses FROM conditions.segment_speed ORDER BY segment_id`;
  expect(held.map((row) => [...row.permission_licenses].sort())).toEqual([
    ["CC-BY-4.0", "CC0-1.0"],
    ["CC-BY-4.0", "CC0-1.0"],
  ]);
  const app = Fastify();
  registerPublishRoutes(app, sql, new FeedStatusStore(), REPO_CATALOG);
  try {
    const visible = await app.inject("/segments.geojson?bbox=5,52,5.2,52.2");
    expect(visible.headers["x-data-license"]).toBe("CC-BY-4.0, CC0-1.0, ODbL-1.0");
    expect(
      visible
        .json()
        .features.map((f: { properties: { current_kph: number } }) => f.properties.current_kph),
    ).toEqual([40, 40]);
    const csv = await app.inject("/segments/speed.csv?bbox=5,52,5.2,52.2");
    expect(csv.body).toContain(",40");
    expect(csv.headers["x-data-license"]).toBe("CC-BY-4.0, CC0-1.0, ODbL-1.0");
    const [visibleTile] = await sql`SELECT conditions.segment_flow(8,131,84,'{}'::json) AS mvt`;
    expect(mvtProperties(visibleTile!.mvt).map((feature) => feature.current_kph)).toEqual([40, 40]);
    await sql`DELETE FROM conditions.public_license_policy WHERE license='CC-BY-4.0'`;
    const denied = await app.inject("/segments.geojson?bbox=5,52,5.2,52.2");
    for (const feature of denied.json().features)
      expect(feature.properties.current_kph).toBeUndefined();
    const [tile] = await sql`SELECT conditions.segment_flow(8,131,84,'{}'::json) AS mvt`;
    for (const feature of mvtProperties(tile!.mvt)) expect(feature.current_kph).toBeUndefined();
  } finally {
    await app.close();
  }
});

it("fails closed for missing receipts and unknown captured upstream licences", async () => {
  for (const [site, license] of [
    ["a", "LicenseRef-Unknown-Upstream"],
    ["b", "CC0-1.0"],
  ]) {
    await writeSiteReadings(
      sql,
      "native",
      [
        {
          site: site!,
          speed: 40,
          at: NOW,
          geometry: { type: "Point", coordinates: [5.1, 52.1] },
          upstream: [{ publisher: "Authority", license: license! }],
        },
      ],
      NOW,
    );
    await sql`INSERT INTO conditions.sensor_segment(subject_key,segment_id,fraction,offset_m,matched_at) VALUES (${siteKey("native", site!)},'1:f',0.5,0,${NOW})`;
  }
  await sql`UPDATE conditions.observation_latest SET contributor_receipt_id=NULL WHERE subject_key=${siteKey("native", "b")}`;
  await writeSensorObservations(sql, () => NOW);
  await fuseSegmentSpeed(sql, () => NOW);
  const [row] =
    await sql`SELECT current_kph,permission_licenses,conditions.flow_public_licenses(permission_licenses) AS public FROM conditions.segment_speed`;
  expect(row!.current_kph).toBe(40);
  expect(row!.permission_licenses).toBeNull();
  expect(row!.public).toBe(false);
  const [unknown] =
    await sql`SELECT conditions.flow_public_licenses(ARRAY['CC0-1.0','LicenseRef-Unknown-Upstream']) AS public`;
  expect(unknown!.public).toBe(false);
});

it("SQL permission unions retain conflicting and missing nested source selectors instead of dropping them", async () => {
  for (const [id, nested] of [
    ["restricted-nested", { license: "ODbL-1.0" }],
    ["missing-nested", {}],
  ] as const) {
    const provenance = {
      sourceId: "native",
      attribution: { provider: "Native", license: "CC0-1.0" },
      upstream: [
        {
          publisher: "Custom upstream",
          license: "CC0-1.0",
          source: { sourceId: "external", attribution: nested },
        },
      ],
    };
    await sql`INSERT INTO conditions.contributor_receipt(id,version,contributors,provenance) VALUES(${id},${CONTRIBUTOR_RECEIPT_VERSION},'[]'::jsonb,${sql.json(provenance)})`;
    const [decision] =
      await sql`SELECT conditions.flow_public_licenses(conditions.flow_receipt_permissions(ARRAY[${id}],true,${CONTRIBUTOR_RECEIPT_VERSION})) AS public`;
    expect(decision!.public).toBe(false);
  }
});
