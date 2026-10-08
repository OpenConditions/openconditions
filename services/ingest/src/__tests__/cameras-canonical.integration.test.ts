import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CamerasCatalogFeed, camerasDomain } from "@openconditions/cameras";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
  writeSnapshot,
} from "@openconditions/storage";
import Fastify, { type FastifyInstance } from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { repoFeed } from "./helpers/catalog.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * Cameras linked across sources in the canonical view: a Digitraffic weather
 * camera, parsed from the cameras package's fixtures, and the OpenStreetMap
 * webcam a mapper put 8 m north of it are one canonical camera that lists the
 * views of both, each with its latest image. OSM is share-alike, so the
 * canonical camera is read in the operator's scope.
 */

type Rec = Record<string, unknown>;

const NOW = new Date("2026-10-08T07:20:00.000Z");
const TOKEN = "operator-token-of-the-canonical-cameras-suite";
const FIXTURES = join(import.meta.dirname, "../../../../packages/cameras/src/__tests__/fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

const digitraffic = repoFeed("fi-digitraffic-cameras") as CamerasCatalogFeed;
const osm = repoFeed("osm-cameras") as CamerasCatalogFeed;
const windy = repoFeed("windy-cameras") as CamerasCatalogFeed;

const C01503 = "oc:feature:fi-digitraffic-cameras:C01503";
const C01632 = "oc:feature:fi-digitraffic-cameras:C01632";
const OSM_NODE = "oc:feature:osm-cameras:node_701";
const WINDY_WEBCAM = "oc:feature:windy-cameras:1179853135";
const WINDY_PAGE = "https://www.windy.com/webcams/1179853135";

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;

const ctx = (cadenceSec: number) => ({
  fetchedAt: NOW.toISOString(),
  cadenceSec,
  reference: {},
});
const wctx = (complete: boolean) => ({
  registry: productionRegistry(),
  instanceId: "test.local",
  now: NOW.toISOString(),
  complete,
});

/** `[lon, lat]` moved north by `metres`. */
const north = ([lon, lat]: readonly number[], metres: number): [number, number] => [
  lon!,
  lat! + metres / 111_320,
];

/** OpenStreetMap webcams at the given places, as Overpass answers them. */
function osmCameras(nodes: { id: number; at: [number, number]; webcam: string }[]): Buffer {
  return Buffer.from(
    JSON.stringify({
      elements: nodes.map((n) => ({
        type: "node",
        id: n.id,
        lon: n.at[0],
        lat: n.at[1],
        tags: { "contact:webcam": n.webcam, "surveillance:type": "webcam" },
      })),
    }),
  );
}

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(productionRegistry()),
    now: NOW,
  });
  await syncSources(sql, [{ ...digitraffic }, { ...osm }, { ...windy }]);

  const stations = camerasDomain.formats["digitraffic"]!.parse(
    digitraffic,
    {
      sites: [fixture("fi-digitraffic-stations.json")],
      details: [
        fixture("fi-digitraffic-station-C01503.json"),
        fixture("fi-digitraffic-station-C01632.json"),
      ],
      status: [fixture("fi-digitraffic-data.json")],
    },
    ctx(600),
  );
  const written = await writeSnapshot(
    sql,
    digitraffic.id,
    { features: stations.features, observations: stations.observations },
    wctx(true),
  );
  expect(written.rejected).toEqual([]);

  const station = stations.features.find((f) => f["id"] === C01503)!;
  const at = (station["location"] as { geometry: { coordinates: number[] } }).geometry.coordinates;
  // Two webcams of one mapper's making 5 m apart, far from any station.
  const elsewhere: [number, number] = [25.5, 62.0];
  const mapped = camerasDomain.formats["overpass"]!.parse(
    osm,
    {
      main: [
        osmCameras([
          { id: 701, at: north(at, 8), webcam: "https://example.org/inkoo/live.jpg" },
          { id: 702, at: elsewhere, webcam: "https://example.org/a.jpg" },
          { id: 703, at: north(elsewhere, 5), webcam: "https://example.org/b.jpg" },
        ]),
      ],
    },
    ctx(86_400),
  );
  const osmWritten = await writeSnapshot(
    sql,
    osm.id,
    { features: mapped.features, observations: mapped.observations },
    wctx(false),
  );
  expect(osmWritten.rejected).toEqual([]);

  // A Windy webcam, untyped, 6 m north of station C01632: Windy's terms ask
  // that its image link to Windy's page, whichever camera survives.
  const loviisa = stations.features.find((f) => f["id"] === C01632)!;
  const loviisaAt = (loviisa["location"] as { geometry: { coordinates: number[] } }).geometry
    .coordinates;
  const page = JSON.parse(fixture("windy-webcams.json").toString("utf8")) as {
    webcams: Rec[];
  };
  const [webcam] = page.webcams;
  const [lon, lat] = north(loviisaAt, 6);
  webcam!["categories"] = [];
  webcam!["location"] = { ...(webcam!["location"] as Rec), longitude: lon, latitude: lat };
  const webcams = camerasDomain.formats["windy"]!.parse(
    windy,
    { main: [Buffer.from(JSON.stringify({ ...page, webcams: [webcam] }))] },
    ctx(540),
  );
  const windyWritten = await writeSnapshot(
    sql,
    windy.id,
    { features: webcams.features, observations: webcams.observations },
    wctx(false),
  );
  expect(windyWritten.rejected).toEqual([]);

  // Every feed polled successfully just now.
  for (const source of [digitraffic.id, osm.id, windy.id]) {
    await sql`INSERT INTO conditions.source_status (source, last_success_at, freshness_window_sec)
      VALUES (${source}, ${NOW}, 1800)
      ON CONFLICT (source) DO UPDATE SET last_success_at = excluded.last_success_at`;
  }

  app = Fastify();
  registerScope(app, TOKEN);
  registerApiRoutes(app, sql, { registry: productionRegistry(), now: () => NOW });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

const canonicalOf = async (featureId: string) => {
  const [row] = await sql<{ canonical_feature_id: string; member_ids: string[] }[]>`
    SELECT canonical_feature_id, member_ids
      FROM conditions.feature_canonical WHERE ${featureId} = ANY(member_ids)`;
  return row!;
};

describe("canonical cameras", () => {
  test("a Digitraffic camera and the OSM webcam 8 m away are one camera with both members' views", async () => {
    const cluster = await canonicalOf(C01503);
    expect([...cluster.member_ids].sort()).toEqual([C01503, OSM_NODE]);

    const res = await app.inject({
      method: "GET",
      url: "/features?kind=camera&canonical=1&expand=components,latest&bbox=23.9,60.0,24.1,60.1",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { records: Rec[]; latest: Record<string, Rec[]> };
    const camera = body.records.find((r) => r["id"] === cluster.canonical_feature_id);
    expect(camera).toMatchObject({ kind: "camera", type: "weather" });
    // The station survives with its own view keys; the OSM view joins under its source.
    const keys = (camera!["components"] as Rec[]).map((c) => c["key"]);
    expect(keys).toEqual(["C0150301", "C0150302", "C0150309", "osm-cameras/0"]);
    expect((camera!["provenance"] as Rec)["mergedSources"]).toEqual([
      expect.objectContaining({ source: "osm-cameras", recordId: OSM_NODE }),
    ]);

    const latest = body.latest[cluster.canonical_feature_id] ?? [];
    // Each canonical view carries its image, fused from the one member view it stands for.
    const byKey = new Map(latest.map((r) => [r["componentKey"] as string, r]));
    expect([...byKey.keys()].sort()).toEqual(keys.slice().sort());
    for (const reading of latest) {
      expect(reading).toMatchObject({ property: "camera.image", source: "@fused" });
    }
    // A station's still holds while its feed polls: its last success plus
    // max(30 min, two of its shortest cadences, 600 s).
    const validUntil = new Date(NOW.getTime() + 1_800_000).toISOString();
    for (const key of ["C0150301", "C0150302", "C0150309"]) {
      const reading = byKey.get(key)!;
      expect(reading["contributors"]).toEqual(["fi-digitraffic-cameras"]);
      expect(reading["validUntil"]).toBe(validUntil);
      expect((reading["result"] as { value: Rec }).value).toMatchObject({
        status: "online",
        imageUrl: `https://weathercam.digitraffic.fi/${key}.jpg`,
      });
    }
    // The OSM still comes from an on-demand source: no validity is computed from its polling.
    const osmReading = byKey.get("osm-cameras/0")!;
    expect(osmReading["contributors"]).toEqual(["osm-cameras"]);
    expect(osmReading["validUntil"]).toBeUndefined();
    expect((osmReading["result"] as { value: Rec }).value["imageUrl"]).toBe(
      "https://example.org/inkoo/live.jpg",
    );
  });

  test("a Windy webcam linked into a Digitraffic station keeps its own page and terms on its view", async () => {
    const cluster = await canonicalOf(C01632);
    expect([...cluster.member_ids].sort()).toEqual([C01632, WINDY_WEBCAM]);

    const res = await app.inject({
      method: "GET",
      url: "/features?kind=camera&canonical=1&expand=components&bbox=26.2,60.4,26.3,60.5",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { records: Rec[] };
    const camera = body.records.find((r) => r["id"] === cluster.canonical_feature_id)!;
    // The station survives: the camera's own details are Digitraffic's.
    expect(camera["details"]).toMatchObject({ imageRedistribution: "allowed" });
    expect(camera["details"]).not.toHaveProperty("detailUrl");
    const views = new Map(
      (camera["components"] as Rec[]).map((c) => [c["key"] as string, c["details"] as Rec]),
    );
    expect(views.get("windy-cameras/0")).toEqual({
      kind: "camera_view",
      v: 1,
      detailUrl: WINDY_PAGE,
      imageRedistribution: "link_only",
    });
    for (const [key, details] of views) {
      if (key.startsWith("windy-cameras/")) continue;
      expect(details, key).toMatchObject({ imageRedistribution: "allowed" });
      expect(details, key).not.toHaveProperty("detailUrl");
    }
  });

  test("two webcams of one source 5 m apart stay two cameras", async () => {
    const first = await canonicalOf("oc:feature:osm-cameras:node_702");
    const second = await canonicalOf("oc:feature:osm-cameras:node_703");
    expect(first.member_ids).toEqual(["oc:feature:osm-cameras:node_702"]);
    expect(second.member_ids).toEqual(["oc:feature:osm-cameras:node_703"]);
  });
});
