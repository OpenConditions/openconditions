import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { registerScope } from "../api/scope.js";
import { FeedStatusStore } from "../feed-status.js";
import { deriveSegmentProfiles } from "../pipeline/segment-profile.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { REPO_CATALOG } from "./helpers/catalog.js";
import { siteKey, writeSiteReadings } from "./helpers/flow-series.js";

let db: TestDatabase;
let sql: postgres.Sql;
const NOW = new Date().toISOString();
const TOKEN = "operator-profile-permission-token-0123456789";
beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120000);
afterAll(async () => {
  await db?.close();
});
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv(
    "SEGMENT_REGIONS",
    JSON.stringify([{ id: "nl", bbox: [3, 50, 8, 54], tz: "Europe/Amsterdam" }]),
  );
  await sql`TRUNCATE conditions.segment_profile,conditions.sensor_segment,conditions.road_segment,conditions.osm_road,conditions.observation_latest CASCADE`;
  await syncSources(sql, [
    {
      id: "native",
      domain: "roads",
      format: "native",
      product: "flow",
      tier: "authoritative",
      operator: "Original publisher",
      license: "CC0-1.0",
      attribution: "Original credit",
      restricted: false,
      cadenceSec: 60,
      freshnessWindowSec: 900,
    },
  ]);
  await sql`INSERT INTO conditions.osm_road(way_id,geom,highway,oneway,region,imported_at) VALUES (1,ST_GeomFromText('LINESTRING(5.1 52.1,5.11 52.1)',4326),'motorway',true,'nl',${NOW})`;
  await sql`INSERT INTO conditions.road_segment(segment_id,way_id,dir,geom,highway,length_m,min_zoom,free_flow_kph,computed_at) VALUES ('1:f',1,'f',ST_GeomFromText('LINESTRING(5.1 52.1,5.11 52.1)',4326),'motorway',1000,5,100,${NOW})`;
});
async function acquireProfile(license: string) {
  await writeSiteReadings(
    sql,
    "native",
    [
      {
        site: "a",
        speed: 40,
        at: NOW,
        geometry: { type: "Point", coordinates: [5.1, 52.1] },
        attribution: { provider: "Captured authority", license: "CC0-1.0" },
        upstream: [
          {
            publisher: "Historical authority",
            license,
            attribution: "Historical required wording",
          },
        ],
      },
    ],
    NOW,
  );
  await sql`INSERT INTO conditions.sensor_segment(subject_key,segment_id,fraction,offset_m,matched_at) VALUES (${siteKey("native", "a")},'1:f',0.5,0,${NOW})`;
  await sql`INSERT INTO conditions.observation_rollup_hourly(series_id,hour_utc,sample_count,bins,counts,min,max,mean,contributor_receipt_ids,lineage_complete)
    SELECT series_id,date_trunc('hour',now()),20,ARRAY[20]::smallint[],ARRAY[20],40,40,40,ARRAY[contributor_receipt_id],true FROM conditions.observation_latest`;
  await sql`UPDATE conditions.source SET operator='Later publisher',attribution='Later credit' WHERE id='native'`;
  await sql`UPDATE conditions.observation_latest SET template=jsonb_set(template,'{provenance,upstream}','[{"publisher":"Current different authority","license":"CC0-1.0"}]'::jsonb)`;
  await deriveSegmentProfiles(sql, () => NOW, { minSamples: 1 });
}
async function withApp(fn: (app: ReturnType<typeof Fastify>) => Promise<void>) {
  const app = Fastify();
  registerScope(app, TOKEN);
  registerPublishRoutes(app, sql, new FeedStatusStore(), REPO_CATALOG);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}
it("withholds an entire historical profile shaped by restricted upstream while operator retains it", async () => {
  await acquireProfile("ODbL-1.0");
  await withApp(async (app) => {
    expect((await app.inject("/segments/profiles.json")).json()).toEqual([]);
    expect(
      (
        await app.inject({
          url: "/segments/profiles.json",
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).json(),
    ).toHaveLength(1);
  });
});
it("publishes exact captured historical profile credits and fails closed for incomplete rollups", async () => {
  await acquireProfile("CC-BY-4.0");
  await withApp(async (app) => {
    const response = await app.inject("/segments/profiles.json");
    const body = response.json();
    expect(response.headers["x-data-license"]).toBe("CC-BY-4.0, CC0-1.0, ODbL-1.0");
    expect(body).toHaveLength(1);
    expect(body[0].lineage_complete).toBe(true);
    expect(body[0].native_sources).toEqual(["native"]);
    expect(body[0].contributors).toContainEqual(
      expect.objectContaining({
        publisher: { name: "Historical authority" },
        attributionText: "Historical required wording",
      }),
    );
    expect(JSON.stringify(body)).not.toContain("Later publisher");
    expect(JSON.stringify(body)).not.toContain("Current different authority");
    await sql`UPDATE conditions.observation_rollup_hourly SET lineage_complete=false`;
    await deriveSegmentProfiles(sql, () => NOW, { minSamples: 1 });
    expect((await app.inject("/segments/profiles.json")).json()).toEqual([]);
  });
});
