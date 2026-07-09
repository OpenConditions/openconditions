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

// A segment with a mix of daytime + nighttime segment_profile buckets.
const PROFILE_SEGMENT_ID = "600:f";
const PROFILE_WKT = "LINESTRING(5.14 52.14, 5.15 52.14)";

// A segment with only a nighttime segment_profile bucket -- no daytime data.
const NIGHT_ONLY_SEGMENT_ID = "800:f";
const NIGHT_ONLY_WKT = "LINESTRING(5.16 52.16, 5.17 52.16)";

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

  // A profiled segment with both daytime (07-19) and nighttime buckets --
  // proves `hourly` is assembled at the right dow*24+tod_hour indices and
  // `constrained_kph` is the median of the daytime buckets only.
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${PROFILE_SEGMENT_ID}, 600, 'f',
      ST_SetSRID(ST_GeomFromText(${PROFILE_WKT}), 4326),
      'primary', 1000, 5, 100, ${NOW})`;
  await sql`
    INSERT INTO conditions.segment_profile (segment_id, dow, tod_hour, speed_kph, sample_count, computed_at)
    VALUES
      (${PROFILE_SEGMENT_ID}, 1, 7, 20, 30, ${NOW}),
      (${PROFILE_SEGMENT_ID}, 1, 12, 30, 30, ${NOW}),
      (${PROFILE_SEGMENT_ID}, 1, 19, 40, 30, ${NOW}),
      (${PROFILE_SEGMENT_ID}, 1, 22, 90, 30, ${NOW})`;

  // A profiled segment with NO daytime buckets -- proves constrained_kph
  // falls back to free_flow_kph rather than being computed from nighttime
  // buckets or omitted.
  await sql`
    INSERT INTO conditions.road_segment
      (segment_id, way_id, dir, geom, highway, length_m, min_zoom, free_flow_kph, computed_at)
    VALUES (${NIGHT_ONLY_SEGMENT_ID}, 800, 'f',
      ST_SetSRID(ST_GeomFromText(${NIGHT_ONLY_WKT}), 4326),
      'primary', 1000, 5, 110, ${NOW})`;
  await sql`
    INSERT INTO conditions.segment_profile (segment_id, dow, tod_hour, speed_kph, sample_count, computed_at)
    VALUES (${NIGHT_ONLY_SEGMENT_ID}, 0, 2, 60, 30, ${NOW})`;
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
        observed_at: NOW,
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
      for (const k of [
        "speed_ratio",
        "los",
        "confidence",
        "current_kph",
        "free_flow_kph",
        "observed_at",
      ]) {
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

describe("GET /segments/profiles.json", () => {
  it("assembles a 168-length hourly array and a daytime-median constrained_kph", async () => {
    const app = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/segments/profiles.json" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(res.headers["cache-control"]).toBe("public, max-age=3600");

      const body = res.json() as {
        way_id: number | string;
        dir: string;
        free_flow_kph: number | null;
        constrained_kph: number | null;
        hourly: (number | null)[];
      }[];

      // Segments with no segment_profile row at all (500, 900, 700) never
      // appear. `way_id` is a bigint column -- postgres-js surfaces it as a
      // string, so compare via String() rather than assuming a JS number.
      const wayIds = body.map((s) => String(s.way_id));
      expect(wayIds).not.toContain("500");
      expect(wayIds).not.toContain("700");

      const profiled = body.find((s) => String(s.way_id) === "600");
      expect(profiled).toBeDefined();
      expect(profiled!.dir).toBe("f");
      expect(profiled!.free_flow_kph).toBe(100);
      expect(profiled!.hourly).toHaveLength(168);
      // dow=1, tod_hour=7/12/19/22 -> indices 31/36/43/46.
      expect(profiled!.hourly[1 * 24 + 7]).toBe(20);
      expect(profiled!.hourly[1 * 24 + 12]).toBe(30);
      expect(profiled!.hourly[1 * 24 + 19]).toBe(40);
      expect(profiled!.hourly[1 * 24 + 22]).toBe(90);
      // Every other bucket is null, not omitted/undefined.
      const populated = new Set([31, 36, 43, 46]);
      for (let i = 0; i < 168; i++) {
        if (!populated.has(i)) expect(profiled!.hourly[i]).toBeNull();
      }
      // Daytime (07-19) buckets are [20, 30, 40] -> median 30.
      expect(profiled!.constrained_kph).toBe(30);

      const nightOnly = body.find((s) => String(s.way_id) === "800");
      expect(nightOnly).toBeDefined();
      expect(nightOnly!.free_flow_kph).toBe(110);
      // No daytime buckets -> falls back to free_flow_kph.
      expect(nightOnly!.constrained_kph).toBe(110);
      expect(nightOnly!.hourly[0 * 24 + 2]).toBe(60);
    } finally {
      await app.close();
    }
  }, 30_000);
});
