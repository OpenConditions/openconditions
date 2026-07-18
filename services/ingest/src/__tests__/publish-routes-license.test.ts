import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import type { RoadEvent } from "@openconditions/roads";
import { FeedStatusStore } from "../feed-status.js";
import { buildDomainRegistry } from "../domains.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { atomicSwap } from "../pipeline/write-postgis.js";

const BBOX = "13,52,14,53";

function baseEvent(overrides: Partial<RoadEvent>): RoadEvent {
  return {
    id: "base",
    source: "lic-test",
    sourceFormat: "wzdx",
    domain: "roads",
    kind: "event",
    type: "roadworks",
    category: "planned",
    isPlanned: true,
    severity: "low",
    severitySource: "derived",
    headline: "Roadworks",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    status: "active",
    roads: [{ name: "A1" }],
    origin: { kind: "feed", attribution: { provider: "p", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-06-23T10:00:00Z",
    fetchedAt: "2026-06-23T10:00:00Z",
    isStale: false,
    ...overrides,
  };
}

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

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

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://oc:oc@${host}:${port}/conditions_test`;
  sql = postgres(url, { max: 3 });

  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("license enforcement on the redistributable export routes", () => {
  it("drops CC-BY-SA records from /observations.geojson and reports only permissive licenses", async () => {
    await atomicSwap(sql, "lic-test-geojson", [
      baseEvent({
        id: "geo-sa-1",
        source: "lic-test-geojson",
        headline: "Share-alike roadworks",
        origin: { kind: "feed", attribution: { provider: "si-nap", license: "CC-BY-SA-4.0" } },
      }),
      baseEvent({
        id: "geo-ok-1",
        source: "lic-test-geojson",
        headline: "Permissive roadworks",
        origin: { kind: "feed", attribution: { provider: "ok-feed", license: "CC-BY-4.0" } },
      }),
    ]);

    const app = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: `/observations.geojson?bbox=${BBOX}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { features: { id: string }[] };
      expect(body.features.map((f) => f.id)).toEqual(["geo-ok-1"]);
      expect(res.headers["x-data-license"]).toBe("CC-BY-4.0");
    } finally {
      await app.close();
    }
  });

  it("excludes only the permissive closure's geometry from /valhalla/exclusions.json", async () => {
    await atomicSwap(sql, "lic-test-valhalla", [
      baseEvent({
        id: "vh-sa-1",
        source: "lic-test-valhalla",
        type: "road_closure",
        category: "incident",
        isPlanned: false,
        severity: "high",
        severitySource: "declared",
        headline: "Share-alike closure",
        geometry: { type: "Point", coordinates: [13.41, 52.51] },
        origin: { kind: "feed", attribution: { provider: "mobidrom", license: "CC-BY-SA-4.0" } },
      }),
      baseEvent({
        id: "vh-ok-1",
        source: "lic-test-valhalla",
        type: "road_closure",
        category: "incident",
        isPlanned: false,
        severity: "high",
        severitySource: "declared",
        headline: "Permissive closure",
        geometry: { type: "Point", coordinates: [13.45, 52.55] },
        origin: { kind: "feed", attribution: { provider: "ok-feed", license: "CC-BY-4.0" } },
      }),
    ]);

    const app = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/valhalla/exclusions.json?bbox=${BBOX}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { exclude_locations: { lon: number; lat: number }[] };
      expect(body.exclude_locations).toEqual([{ lon: 13.45, lat: 52.55 }]);
      expect(res.headers["x-data-license"]).toBe("CC-BY-4.0");
    } finally {
      await app.close();
    }
  });

  describe("GET /stream (SSE)", () => {
    it("never emits a CC-BY-SA record, and omits sourceRaw unless ?raw=1", async () => {
      await atomicSwap(sql, "lic-test-stream", [
        baseEvent({
          id: "sse-sa-1",
          source: "lic-test-stream",
          // Distinct geometry from the other describe blocks' fixtures so the
          // cross-source dedup pass in readObservations never clusters this
          // with an unrelated test's same-type event at the same point.
          geometry: { type: "Point", coordinates: [13.9, 52.9] },
          origin: { kind: "feed", attribution: { provider: "mobidrom", license: "CC-BY-SA-4.0" } },
          sourceRaw: { marker: "RAW_MARKER_SA" },
        }),
        baseEvent({
          id: "sse-ok-1",
          source: "lic-test-stream",
          geometry: { type: "Point", coordinates: [13.9, 52.9] },
          origin: { kind: "feed", attribution: { provider: "ok-feed", license: "CC-BY-4.0" } },
          sourceRaw: { marker: "RAW_MARKER_OK" },
        }),
      ]);

      const app = Fastify();
      const registry = await buildDomainRegistry();
      registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const readFrames = async (url: string): Promise<string> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        try {
          const res = await fetch(url, { signal: controller.signal });
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          try {
            while (!buf.includes("\n\n")) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) buf += decoder.decode(value, { stream: true });
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
          return buf;
        } finally {
          clearTimeout(timeout);
        }
      };

      try {
        const defaultFrames = await readFrames(`http://127.0.0.1:${port}/stream?bbox=${BBOX}`);
        expect(defaultFrames).toContain("sse-ok-1");
        expect(defaultFrames).not.toContain("sse-sa-1");
        expect(defaultFrames).not.toContain("RAW_MARKER_OK");
        expect(defaultFrames).not.toContain("RAW_MARKER_SA");

        const rawFrames = await readFrames(`http://127.0.0.1:${port}/stream?bbox=${BBOX}&raw=1`);
        expect(rawFrames).toContain("sse-ok-1");
        expect(rawFrames).toContain("RAW_MARKER_OK");
        expect(rawFrames).not.toContain("sse-sa-1");
        expect(rawFrames).not.toContain("RAW_MARKER_SA");
      } finally {
        await app.close();
      }
    }, 15_000);
  });
});
