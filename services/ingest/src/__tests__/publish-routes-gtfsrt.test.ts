import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import type { Observation } from "@openconditions/core";
import { FeedStatusStore } from "../feed-status.js";
import { buildDomainRegistry } from "../domains.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { atomicSwap } from "../pipeline/write-postgis.js";

const { transit_realtime } = GtfsRealtimeBindings;
const BBOX = "13,52,14,53";

function baseEvent(overrides: Partial<Observation> & Record<string, unknown>): Observation {
  return {
    id: "base",
    source: "gtfsrt-route-test",
    sourceFormat: "wzdx",
    domain: "roads",
    kind: "event",
    type: "transit_disruption",
    category: "incident",
    severity: "high",
    severitySource: "derived",
    headline: "Disruption",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    status: "active",
    origin: { kind: "feed", attribution: { provider: "p", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-06-23T10:00:00Z",
    fetchedAt: "2026-06-23T10:00:00Z",
    isStale: false,
    ...overrides,
  } as Observation;
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

describe("GET /gtfs-rt/alerts.pb — cross-domain read + selector gate", () => {
  it("emits the transit event's selector and never a road/feed-wide alert", async () => {
    await atomicSwap(sql, "gtfsrt-route-test", [
      // A transit-domain event — the old `domain: "roads"` default would have
      // silently dropped this, so its presence pins the cross-domain read.
      baseEvent({
        id: "transit-route-1",
        domain: "transit",
        geometry: { type: "Point", coordinates: [13.41, 52.41] },
        subject: [{ type: "gtfs-route", id: "R7" }],
      }),
      // A plain road event with no transit selector — must be excluded, and must
      // never contribute a selector-less (network-wide) alert.
      baseEvent({
        id: "road-noselector-1",
        domain: "roads",
        type: "accident",
        geometry: { type: "Point", coordinates: [13.6, 52.6] },
      }),
    ]);

    const app = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: `/gtfs-rt/alerts.pb?bbox=${BBOX}` });
      expect(res.statusCode).toBe(200);
      const feed = transit_realtime.FeedMessage.decode(res.rawPayload);

      // Only the transit-selector-bearing event is present.
      expect(feed.entity.map((e) => e.id)).toEqual(["transit-route-1"]);
      const sel = feed.entity[0]!.alert!.informedEntity!;
      expect(sel.map((s) => s.routeId).filter(Boolean)).toEqual(["R7"]);

      // No entity anywhere carries an empty (feed-wide) selector.
      for (const e of feed.entity) {
        for (const s of e.alert?.informedEntity ?? []) {
          expect(Object.keys(s).length).toBeGreaterThan(0);
        }
      }
    } finally {
      await app.close();
    }
  });
});
