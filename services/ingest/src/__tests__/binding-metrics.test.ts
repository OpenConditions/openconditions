import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { RESOLVER_VERSION } from "@openconditions/roads";
import { FeedStatusStore } from "../feed-status.js";
import { buildDomainRegistry } from "../domains.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { createBindingMetricsReader } from "../pipeline/binding-metrics.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-09-06T00:00:00.000Z";

async function insertEvent(id: string, source: string): Promise<void> {
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, category, severity, severity_source,
       headline, status, geom, attributes, valid_from, origin,
       data_updated_at, fetched_at, source_license)
    VALUES (${id}, ${source}, 'datex2', 'roads', 'event', 'road_closure', 'incident',
      'high', 'declared', 'Closure', 'active',
      ST_SetSRID(ST_GeomFromText('POINT(6.85 51.2)'), 4326),
      ${sql.json({})}, ${NOW},
      ${sql.json({ kind: "feed", attribution: { provider: source, license: "CC0-1.0" } })},
      ${NOW}, ${NOW}, 'CC0-1.0')`;
}

async function insertBinding(id: string, status: string): Promise<void> {
  await sql`
    INSERT INTO conditions.observation_binding
      (observation_id, status, confidence, direction_mode, candidate_count,
       alternative_confidence, reason, resolver_version, geom_hash, bound_at)
    VALUES (${id}, ${status}, 0.9, 'single', 1, null, null,
      ${RESOLVER_VERSION}, ${`hash-${id}`}, ${NOW})`;
}

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

  await insertEvent("a:1", "de-autobahn");
  await insertBinding("a:1", "exact");
  await insertEvent("a:2", "de-autobahn");
  await insertBinding("a:2", "unresolved");
  // An unbound event of another feed: it must not create a `binding` key.
  await insertEvent("n:1", "nl-ndw");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

async function withApp<T>(fn: (app: ReturnType<typeof Fastify>) => Promise<T>): Promise<T> {
  const app = Fastify();
  const registry = await buildDomainRegistry();
  registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
  await app.ready();
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

type StatusBody = {
  feeds: { id: string; binding?: Record<string, number> }[];
};

async function feedsStatus(app: ReturnType<typeof Fastify>): Promise<StatusBody> {
  const res = await app.inject({ method: "GET", url: "/feeds/status" });
  expect(res.statusCode).toBe(200);
  return res.json() as StatusBody;
}

describe("binding metrics on GET /feeds/status", () => {
  it("reports per-status counts for a source with bindings and omits the key otherwise", async () => {
    await withApp(async (app) => {
      const body = await feedsStatus(app);
      const autobahn = body.feeds.find((f) => f.id === "de-autobahn");
      expect(autobahn?.binding).toEqual({
        attempted: 2,
        exact: 1,
        likely: 0,
        ambiguous: 0,
        unresolved: 1,
        noCoverage: 0,
        notApplicable: 0,
      });
      const ndw = body.feeds.find((f) => f.id === "nl-ndw");
      expect(ndw).toBeTruthy();
      expect(ndw && "binding" in ndw).toBe(false);
    });
  });

  it("serves the cached counts within the TTL and refreshes once it lapses", async () => {
    await withApp(async (app) => {
      const first = await feedsStatus(app);
      expect(first.feeds.find((f) => f.id === "de-autobahn")?.binding?.attempted).toBe(2);

      await insertEvent("a:3", "de-autobahn");
      await insertBinding("a:3", "likely");

      const second = await feedsStatus(app);
      expect(second.feeds.find((f) => f.id === "de-autobahn")?.binding).toEqual({
        attempted: 2,
        exact: 1,
        likely: 0,
        ambiguous: 0,
        unresolved: 1,
        noCoverage: 0,
        notApplicable: 0,
      });
    });

    // A reader whose TTL has already lapsed re-queries and sees the third row.
    const fresh = createBindingMetricsReader(sql, 0);
    expect((await fresh()).get("de-autobahn")).toEqual({
      attempted: 3,
      exact: 1,
      likely: 1,
      ambiguous: 0,
      unresolved: 1,
      noCoverage: 0,
      notApplicable: 0,
    });
  });

  it("counts an unknown status toward attempted without inventing a key", async () => {
    await insertEvent("a:weird", "de-autobahn");
    await insertBinding("a:weird", "something_new");
    const reader = createBindingMetricsReader(sql, 0);
    const metrics = await reader();
    expect(metrics.get("de-autobahn")).toEqual({
      attempted: 4,
      exact: 1,
      likely: 1,
      ambiguous: 0,
      unresolved: 1,
      noCoverage: 0,
      notApplicable: 0,
    });
    await sql`DELETE FROM conditions.observations WHERE id = 'a:weird'`;
  });
});
