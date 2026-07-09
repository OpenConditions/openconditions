import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { FeedStatusStore } from "../feed-status.js";
import { buildDomainRegistry } from "../domains.js";
import { registerPublishRoutes } from "../publish-routes.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-01-01T00:00:00.000Z";

// A single segment near Utrecht, NL: lon 5.1, lat 52.1 -- well inside BBOX.
const SEGMENT_ID = "500:f";
const SEGMENT_WKT = "LINESTRING(5.1 52.1, 5.11 52.1)";
const BBOX = "5,52,5.2,52.2";

// A speed-less segment far outside BBOX -- proves the bbox filter, not just
// the LEFT JOIN, actually restricts the result set.
const FAR_SEGMENT_ID = "900:f";
const FAR_WKT = "LINESTRING(-170 0, -170.01 0)";

// A base segment INSIDE the bbox with NO segment_speed row -- the LEFT JOIN
// yields SQL NULL for every speed column. Proves a real driver null never
// leaks into the emitted GeoJSON as a `null` property.
const BASE_SEGMENT_ID = "700:f";
const BASE_WKT = "LINESTRING(5.12 52.12, 5.13 52.12)";

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

  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, ref, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${SEGMENT_ID}, 500, 'f',
      ST_SetSRID(ST_GeomFromText(${SEGMENT_WKT}), 4326),
      'motorway', 'A2', 1000, 5, 100, ${NOW})`;
  await sql`
    INSERT INTO conditions.segment_speed
      (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, source_tier, contributing, is_estimated, observed_at, updated_at)
    VALUES (${SEGMENT_ID}, 50, 100, 0.5, 'heavy', 'measured', 'sensor', ARRAY['test-source'], false, ${NOW}, ${NOW})`;

  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${FAR_SEGMENT_ID}, 900, 'f',
      ST_SetSRID(ST_GeomFromText(${FAR_WKT}), 4326),
      'motorway', 1000, 5, 100, ${NOW})`;

  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${BASE_SEGMENT_ID}, 700, 'f',
      ST_SetSRID(ST_GeomFromText(${BASE_WKT}), 4326),
      'primary', 1000, 5, 100, ${NOW})`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("GET /segments.geojson", () => {
  it("returns a FeatureCollection with the bbox segment's speed properties, excluding the far segment", async () => {
    const app = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: `/segments.geojson?bbox=${BBOX}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/geo+json; charset=utf-8");
      expect(res.headers["cache-control"]).toBe("public, max-age=60");

      const body = res.json() as {
        type: string;
        features: { geometry: unknown; properties: Record<string, unknown> }[];
      };
      expect(body.type).toBe("FeatureCollection");
      const ids = body.features.map((f) => f.properties["segment_id"]);
      expect(ids).toContain(SEGMENT_ID);
      expect(ids).not.toContain(FAR_SEGMENT_ID);

      const f = body.features.find((x) => x.properties["segment_id"] === SEGMENT_ID)!;
      expect(f.properties).toMatchObject({
        segment_id: SEGMENT_ID,
        dir: "f",
        highway: "motorway",
        ref: "A2",
        speed_ratio: 0.5,
        los: "heavy",
        confidence: "measured",
        current_kph: 50,
        free_flow_kph: 100,
      });
      expect(f.geometry).toEqual({
        type: "LineString",
        coordinates: [
          [5.1, 52.1],
          [5.11, 52.1],
        ],
      });
    } finally {
      await app.close();
    }
  }, 30_000);

  it("emits a base segment with no segment_speed row (LEFT JOIN) without leaking driver nulls as JSON null props", async () => {
    const app = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: `/segments.geojson?bbox=${BBOX}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        features: { properties: Record<string, unknown> }[];
      };
      const base = body.features.find((f) => f.properties["segment_id"] === BASE_SEGMENT_ID);
      expect(base).toBeDefined();
      expect(base!.properties).toEqual({
        segment_id: BASE_SEGMENT_ID,
        dir: "f",
        highway: "primary",
      });
      for (const k of ["speed_ratio", "los", "confidence", "current_kph", "free_flow_kph"]) {
        expect(k in base!.properties).toBe(false);
      }
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects a request with no bbox", async () => {
    const app = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/segments.geojson" });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("GET /segments/speed.csv", () => {
  it("returns the header and a row for the measured segment, omitting speed-less segments", async () => {
    const app = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/segments/speed.csv" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/csv");
      expect(res.headers["cache-control"]).toBe("public, max-age=60");

      const lines = res.body.split("\n");
      expect(lines[0]).toBe("way_id,dir,current_kph,free_flow_kph,los");
      expect(lines).toContain("500,f,50,100,heavy");
      // BASE_SEGMENT_ID (700) has no segment_speed row -- must not appear.
      expect(res.body).not.toContain("700,");
    } finally {
      await app.close();
    }
  }, 30_000);
});
