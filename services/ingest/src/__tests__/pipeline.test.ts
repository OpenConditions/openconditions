import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { MIGRATION_SQL } from "@openconditions/core";
import { FEED_SOURCES } from "@openconditions/roads";
import { runSource } from "../pipeline/run.js";
import type { DomainFeedSource } from "../pipeline/run.js";

const NDW_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/ndw/actueel_beeld.xml"
);

const DRIVEBC_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../packages/roads/src/__tests__/fixtures/drivebc/events.json"
);

const ndwFeed: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "ndw")!,
  domain: "roads",
};

const drivebcFeed: DomainFeedSource = {
  ...FEED_SOURCES.find((f) => f.id === "drivebc")!,
  domain: "roads",
};

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
  sql = postgres(`postgres://oc:oc@${host}:${port}/conditions_test`, { max: 3 });

  for (const statement of MIGRATION_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await sql.unsafe(statement);
  }
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("pipeline — happy path", () => {
  it("inserts rows from the NDW fixture into conditions.observations", async () => {
    const xmlPayload = readFileSync(NDW_FIXTURE_PATH);

    const fakeFetch = async (_url: string | URL | Request): Promise<Response> => {
      return new Response(xmlPayload, { status: 200 });
    };

    const result = await runSource(ndwFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      now: () => new Date().toISOString(),
    });

    expect(result.count).toBeGreaterThan(0);
    console.info(`[test] inserted ${result.count} rows`);

    const wrongRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.observations
      WHERE domain <> 'roads' OR source <> 'ndw'
    `;
    expect(parseInt(wrongRows[0]!.count, 10)).toBe(0);
  }, 60_000);

  it("all inserted geometries are valid PostGIS geometries", async () => {
    const invalid = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.observations
      WHERE NOT ST_IsValid(geom)
    `;
    expect(parseInt(invalid[0]!.count, 10)).toBe(0);
  }, 30_000);

  it("at least one row has road-specific attributes (isPlanned present)", async () => {
    const rows = await sql<{ attributes: unknown }[]>`
      SELECT attributes
      FROM conditions.observations
      WHERE domain = 'roads'
      LIMIT 100
    `;
    const hasRoadAttrs = rows.some((r) => {
      const attrs = r.attributes as Record<string, unknown> | null;
      return attrs != null && "isPlanned" in attrs;
    });
    expect(hasRoadAttrs).toBe(true);
  }, 30_000);
});

describe("pipeline — feed downtime", () => {
  it("leaves existing rows intact when fetch throws", async () => {
    const beforeCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw'
    `;
    const countBefore = parseInt(beforeCount[0]!.count, 10);
    expect(countBefore).toBeGreaterThan(0);

    const throwingFetch = async (_url: string | URL | Request): Promise<Response> => {
      throw new Error("simulated network failure");
    };

    const result = await runSource(ndwFeed, {
      sql,
      fetch: throwingFetch as typeof fetch,
      now: () => new Date().toISOString(),
    });

    expect(result.count).toBe(0);

    const afterCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM conditions.observations WHERE source = 'ndw'
    `;
    const countAfter = parseInt(afterCount[0]!.count, 10);
    expect(countAfter).toBe(countBefore);
  }, 30_000);
});

describe("pipeline — open511 (DriveBC)", () => {
  it("inserts rows from the DriveBC fixture with source='drivebc' and domain='roads'", async () => {
    const jsonPayload = readFileSync(DRIVEBC_FIXTURE_PATH);

    const fakeFetch = async (_url: string | URL | Request): Promise<Response> => {
      return new Response(jsonPayload, { status: 200 });
    };

    const result = await runSource(drivebcFeed, {
      sql,
      fetch: fakeFetch as typeof fetch,
      now: () => new Date().toISOString(),
    });

    expect(result.count).toBeGreaterThan(0);
    console.info(`[test] drivebc: inserted ${result.count} rows`);

    const wrongRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.observations
      WHERE source = 'drivebc' AND (domain <> 'roads')
    `;
    expect(parseInt(wrongRows[0]!.count, 10)).toBe(0);
  }, 60_000);

  it("all DriveBC geometries are valid PostGIS geometries", async () => {
    const invalid = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM conditions.observations
      WHERE source = 'drivebc' AND NOT ST_IsValid(geom)
    `;
    expect(parseInt(invalid[0]!.count, 10)).toBe(0);
  }, 30_000);
});
