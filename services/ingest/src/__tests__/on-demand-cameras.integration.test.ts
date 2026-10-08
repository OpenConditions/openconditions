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
import { fakeLookup } from "./helpers/on-demand.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * OpenStreetMap's and Windy's webcams read through on demand, and the
 * restricted camera feeds withheld from the public. Overpass and Windy answer
 * from the cameras package's fixtures (around Innsbruck: the 1° cell
 * 11–12 E, 47–48 N, and the 0.25° cell 11.25–11.5 E, 47.25–47.5 N). OSM is
 * share-alike, Windy's terms forbid redistribution and the 511 states publish
 * no data licence, so their cameras are the operator's only; TfL's are open.
 */

type Rec = Record<string, unknown>;

const NOW = new Date("2026-10-08T07:00:00.000Z");
const TOKEN = "operator-token-of-the-on-demand-cameras-suite-1";
const WINDY_KEY = "windy-test-key";
const FIXTURES = join(import.meta.dirname, "../../../../packages/cameras/src/__tests__/fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

// The feeds as the catalogue ships them, so a catalogue change is tested here too.
const osmCameras = repoFeed("osm-cameras");
const windyCameras = repoFeed("windy-cameras");
const georgia = repoFeed("us-ga-511-cameras");
const tfl = repoFeed("gb-eng-tfl-cameras");

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;
const asked: { url: string; method: string; body: string; headers: Headers }[] = [];

/** Overpass and Windy, answering every cell from their fixtures. */
const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  asked.push({
    url,
    method: init?.method ?? "GET",
    body: String(init?.body ?? ""),
    headers: new Headers(init?.headers),
  });
  const host = new URL(url).hostname;
  const body =
    host === "overpass-api.de"
      ? fixture("osm-cameras.json")
      : host === "api.windy.com"
        ? fixture("windy-webcams.json")
        : undefined;
  if (body === undefined) return new Response("unknown upstream", { status: 404 });
  return new Response(body, { headers: { "content-type": "application/json" } });
}) as typeof fetch;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(productionRegistry()),
    now: NOW,
  });
  await syncSources(sql, [{ ...osmCameras }, { ...windyCameras }, { ...georgia }, { ...tfl }]);
  app = Fastify();
  registerScope(app, TOKEN);
  registerApiRoutes(app, sql, {
    registry: productionRegistry(),
    now: () => NOW,
    onDemand: {
      catalog: { feeds: [osmCameras, windyCameras] },
      fetch: upstream,
      lookup: fakeLookup,
      deadlineMs: 10_000,
      instanceId: "test.local",
      env: { WINDY_CAMERAS_API_KEY: WINDY_KEY },
    },
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

const read = async (path: string, operator: boolean) => {
  const res = await app.inject({
    method: "GET",
    url: path,
    ...(operator ? { headers: { authorization: `Bearer ${TOKEN}` } } : {}),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Rec & {
    records: Rec[];
    latest?: Record<string, Rec[]>;
    coverage?: Rec;
  };
};

const sourceOf = (record: Rec) => (record["provenance"] as Rec)["sourceId"];
const expiresOf = (record: Rec) => (record["freshness"] as Rec)["expiresAt"];

const ctx = (cadenceSec: number) => ({
  fetchedAt: NOW.toISOString(),
  cadenceSec,
  reference: {},
});
const wctx = {
  registry: productionRegistry(),
  instanceId: "test.local",
  now: NOW.toISOString(),
  complete: true,
};

describe("on-demand cameras", () => {
  test("an OSM read fills its cell once, with every camera expiring at the cell's lifetime", async () => {
    const path =
      "/features?bbox=11.34,47.25,11.46,47.32&kind=camera&source=osm-cameras&expand=components,latest";
    const body = await read(path, true);
    expect(body.coverage).toEqual({
      partial: false,
      sources: [{ id: "osm-cameras", complete: true }],
    });
    const overpass = asked.filter((a) => a.url === "https://overpass-api.de/api/interpreter");
    expect(overpass).toHaveLength(1);
    expect(overpass[0]!.method).toBe("POST");
    expect(overpass[0]!.body).toContain('nwr["contact:webcam"](47,11,48,12);');
    expect(overpass[0]!.body).toContain(
      'nwr["man_made"="surveillance"]["surveillance:type"="webcam"](47,11,48,12);',
    );
    expect(overpass[0]!.body).toContain('nwr["webcam"](47,11,48,12);');
    expect(overpass[0]!.headers.get("user-agent")).toMatch(/^OpenConditions-OsmCameras\/1\.0/);

    const expiresAt = new Date(NOW.getTime() + 86_400_000).toISOString();
    expect(body.records.map((r) => r["id"]).sort()).toEqual([
      "oc:feature:osm-cameras:node_11351370844",
      "oc:feature:osm-cameras:node_8729244903",
      "oc:feature:osm-cameras:node_9569407667",
    ]);
    for (const record of body.records) {
      expect(record["provenance"]).toMatchObject({
        sourceId: "osm-cameras",
        accessMode: "on_demand",
      });
      expect(expiresOf(record)).toBe(expiresAt);
    }
    const ledger = await sql<{ cell: string; status: string; expires_at: Date }[]>`
      SELECT cell, status, expires_at FROM conditions.on_demand_fetch
       WHERE source_id = 'osm-cameras'`;
    expect(ledger.map((r) => [r.cell, r.status, r.expires_at.toISOString()])).toEqual([
      ["1/11/47", "fresh", expiresAt],
    ]);
    // The image reading of the camera whose OSM link is a still expires with the cell too.
    const [reading] = body.latest?.["oc:feature:osm-cameras:node_9569407667"] ?? [];
    expect(reading).toMatchObject({
      property: "camera.image",
      componentKey: "0",
      result: {
        value: {
          imageUrl: "https://www.foto-webcam.eu/webcam/innsbruck-uni-west/current/1920.jpg",
        },
      },
      source: "osm-cameras",
    });
    const [stored] = await sql<{ expires_at: Date }[]>`
      SELECT expires_at FROM conditions.observation_latest
       WHERE feature_id = 'oc:feature:osm-cameras:node_9569407667' AND property = 'camera.image'`;
    expect(stored?.expires_at.toISOString()).toBe(expiresAt);

    // The cell is fresh, so a second read inside its lifetime fetches nothing.
    const before = asked.length;
    const again = await read(path, true);
    expect(asked).toHaveLength(before);
    expect(again.records).toHaveLength(3);
  });

  test("a Windy read sends the key in its header and keeps the cameras of its cell", async () => {
    const body = await read(
      "/features?bbox=11.38,47.26,11.41,47.32&kind=camera&source=windy-cameras",
      true,
    );
    expect(body.coverage).toEqual({
      partial: false,
      sources: [{ id: "windy-cameras", complete: true }],
    });
    const windy = asked.filter((a) => new URL(a.url).hostname === "api.windy.com");
    expect(windy).toHaveLength(1);
    expect(new URL(windy[0]!.url).searchParams.get("bbox")).toBe("47.5,11.5,47.25,11.25");
    expect(windy[0]!.headers.get("x-windy-api-key")).toBe(WINDY_KEY);
    // The third webcam of the answer lies south of the cell.
    expect(body.records.map((r) => r["id"]).sort()).toEqual([
      "oc:feature:windy-cameras:1179853135",
      "oc:feature:windy-cameras:1179853136",
    ]);
    // Free-tier image URLs die after ten minutes: the cell lives nine.
    for (const record of body.records) {
      expect(expiresOf(record)).toBe(new Date(NOW.getTime() + 540_000).toISOString());
    }
  });

  test("the public scope is given no Windy, OSM or 511 state camera; TfL's are open", async () => {
    const parse = (feed: typeof georgia, name: string, cadenceSec: number) =>
      camerasDomain.formats[feed.format]!.parse(
        feed as CamerasCatalogFeed,
        { main: [fixture(name)] },
        ctx(cadenceSec),
      );
    for (const [feed, name, cadenceSec] of [
      [georgia, "us-ga-511-cameras.json", 900],
      [tfl, "gb-eng-tfl-jamcams.json", 3600],
    ] as const) {
      const parsed = parse(feed, name, cadenceSec);
      expect(parsed.features.length).toBeGreaterThan(0);
      const written = await writeSnapshot(
        sql,
        feed.id,
        { features: parsed.features, observations: parsed.observations },
        wctx,
      );
      expect(written.rejected).toEqual([]);
    }

    const sources = (records: Rec[]) => [...new Set(records.map(sourceOf))].sort();
    const operator = await read("/features?kind=camera&limit=100", true);
    expect(sources(operator.records)).toEqual([
      "gb-eng-tfl-cameras",
      "osm-cameras",
      "us-ga-511-cameras",
      "windy-cameras",
    ]);
    const open = await read("/features?kind=camera&limit=100&expand=components,latest", false);
    expect(sources(open.records)).toEqual(["gb-eng-tfl-cameras"]);
    expect(JSON.stringify(open)).not.toMatch(/windy-cameras|osm-cameras|us-ga-511-cameras/);
  });
});
