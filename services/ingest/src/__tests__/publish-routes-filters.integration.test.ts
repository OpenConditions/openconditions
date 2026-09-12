import { runMigrations } from "@openconditions/core/server";
import type { RoadEvent } from "@openconditions/roads";
import Fastify from "fastify";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDomainRegistry } from "../domains.js";
import { FeedStatusStore } from "../feed-status.js";
import { atomicSwap } from "../pipeline/write-postgis.js";
import { registerPublishRoutes } from "../publish-routes.js";

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

describe("restriction view cache lifetime", () => {
  const RESTRICTION_SOURCE = "restriction-cache-test";

  function details(over: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      vehicleScope: "specific",
      completeness: "complete",
      issues: [],
      source: {
        sourceId: RESTRICTION_SOURCE,
        recordId: "GUID50465935",
        recordVersion: "31",
        sourceUpdatedAt: "2026-08-28T04:18:02.629Z",
        feedUrls: ["https://tie.digitraffic.fi/api/traffic-message/v2/roadworks"],
        publisher: "Fintraffic / Digitraffic",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        attribution: "Fintraffic / Digitraffic",
        modificationNotice: "Normalized by OpenConditions",
      },
      facts: [
        {
          id: "f1",
          kind: "dimension",
          dimension: "gross_weight",
          meaning: "maximum_permitted",
          value: 26000,
          unit: "kg",
          operator: "lte",
          scope: {
            kind: "roadwork_phase",
            phaseId: "GUID50469933",
            locationDescription: null,
            sourceLocationRefs: { scheme: "digitraffic_road_address" },
            restrictionBinding: "not_established",
          },
          direction: { basis: "road_reference", value: "both", description: null },
          validFrom: "2026-07-19T21:00:00.000Z",
          validTo: null,
          sourceTokens: { type: "vehicle gross weight limit" },
          context: {
            restrictionsLiftable: false,
            compliance: "unknown",
            operatorActionStatus: null,
            validityStatus: null,
          },
        },
      ],
      ...over,
    };
  }

  async function cacheControl(): Promise<string | undefined> {
    const app = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/observations.geojson?bbox=${BBOX}`,
      });
      expect(res.statusCode).toBe(200);
      return res.headers["cache-control"] as string | undefined;
    } finally {
      await app.close();
    }
  }

  it("caps a restriction-bearing response at 60 seconds and never caches an unsupported one", async () => {
    const unconditional = await cacheControl();
    expect(unconditional).toBe("public, max-age=90");

    await atomicSwap(
      sql,
      RESTRICTION_SOURCE,
      [
        baseEvent({
          id: `${RESTRICTION_SOURCE}:1`,
          source: RESTRICTION_SOURCE,
          validFrom: null,
          restrictionDetails: details(),
        } as never),
      ],
      600,
    );
    await sql`UPDATE conditions.source_status SET last_success_at = now()
      WHERE source = ${RESTRICTION_SOURCE}`;
    const bounded = await cacheControl();
    expect(bounded).toMatch(/^public, max-age=([1-9]|[1-5][0-9]|60)$/);

    await atomicSwap(
      sql,
      RESTRICTION_SOURCE,
      [
        baseEvent({
          id: `${RESTRICTION_SOURCE}:1`,
          source: RESTRICTION_SOURCE,
          validFrom: null,
          restrictionDetails: { schemaVersion: 9 },
        } as never),
      ],
      600,
    );
    expect(await cacheControl()).toBe("no-store");

    await sql`DELETE FROM conditions.observations WHERE source = ${RESTRICTION_SOURCE}`;
    await sql`DELETE FROM conditions.source_status WHERE source = ${RESTRICTION_SOURCE}`;
  }, 60_000);
});
