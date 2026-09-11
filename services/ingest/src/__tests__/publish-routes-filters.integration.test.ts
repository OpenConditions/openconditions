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
const SOURCE = "filter-test";

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function baseEvent(overrides: Partial<RoadEvent>): RoadEvent {
  return {
    id: "base",
    source: SOURCE,
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

  await atomicSwap(sql, SOURCE, [
    baseEvent({ id: "now-open", headline: "Active roadworks", validFrom: null }),
    baseEvent({
      id: "accident-now",
      type: "accident",
      category: "incident",
      isPlanned: false,
      severity: "high",
      severitySource: "declared",
      headline: "Collision",
      geometry: { type: "Point", coordinates: [13.42, 52.52] },
      validFrom: null,
    }),
    baseEvent({
      id: "starts-in-2d",
      headline: "Roadworks starting in two days",
      geometry: { type: "Point", coordinates: [13.44, 52.54] },
      validFrom: inDays(2),
      validTo: inDays(20),
    }),
    baseEvent({
      id: "starts-in-30d",
      headline: "Roadworks starting in a month",
      geometry: { type: "Point", coordinates: [13.46, 52.56] },
      validFrom: inDays(30),
      validTo: inDays(60),
    }),
  ]);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

async function idsFor(query: string): Promise<string[]> {
  const app = Fastify();
  const registry = await buildDomainRegistry();
  registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
  await app.ready();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/observations.geojson?bbox=${BBOX}${query}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { features: { id: string }[] };
    return body.features.map((f) => f.id).sort();
  } finally {
    await app.close();
  }
}

describe("query filters on the public read routes", () => {
  it("serves every stored event when no filter params are given", async () => {
    expect(await idsFor("")).toEqual(["accident-now", "now-open", "starts-in-2d", "starts-in-30d"]);
  });

  it("narrows by a comma-separated types list", async () => {
    expect(await idsFor("&types=accident")).toEqual(["accident-now"]);
    expect(await idsFor("&types=accident,roadworks")).toEqual([
      "accident-now",
      "now-open",
      "starts-in-2d",
      "starts-in-30d",
    ]);
  });

  it("narrows by minSeverity", async () => {
    expect(await idsFor("&minSeverity=high")).toEqual(["accident-now"]);
  });

  it("narrows by horizonDays, keeping events with no announced start", async () => {
    expect(await idsFor("&horizonDays=0")).toEqual(["accident-now", "now-open"]);
    expect(await idsFor("&horizonDays=7")).toEqual(["accident-now", "now-open", "starts-in-2d"]);
  });

  it("treats invalid filter values as absent rather than erroring", async () => {
    const all = ["accident-now", "now-open", "starts-in-2d", "starts-in-30d"];
    expect(await idsFor("&minSeverity=bogus")).toEqual(all);
    expect(await idsFor("&horizonDays=-1")).toEqual(all);
    expect(await idsFor("&horizonDays=abc")).toEqual(all);
    expect(await idsFor("&types=")).toEqual(all);
  });
});
