import { RESOLVER_VERSION } from "@openconditions/roads";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FeedStatusStore } from "../feed-status.js";
import { createBindingMetricsReader } from "../pipeline/binding-metrics.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { REPO_CATALOG } from "./helpers/catalog.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";
import { bindSituation, situationDraft, writeSituations } from "./helpers/situations.js";

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

const id = (source: string, local: string) => `oc:situation:${source}:${local}`;

/** Adds a live situation without withdrawing the source's others. */
async function insertSituation(local: string, source: string): Promise<void> {
  await writeSituations(sql, source, [situationDraft(local, {}, source)], undefined, false);
}

async function insertBinding(
  source: string,
  local: string,
  status: string,
  current = true,
): Promise<void> {
  await bindSituation(sql, id(source, local), {
    status,
    confidence: 0.9,
    generation: current ? "graph-current" : "graph-previous",
    resolverVersion: RESOLVER_VERSION,
  });
}

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await sql`
    INSERT INTO conditions.road_graph_state
      (singleton, generation, regions, highway_classes, pbf_provenance, imported_at, activated_at)
    VALUES (true, 'graph-current', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now(), now())`;

  await insertSituation("1", "de-autobahn-events");
  await insertBinding("de-autobahn-events", "1", "exact");
  await insertSituation("2", "de-autobahn-events");
  await insertBinding("de-autobahn-events", "2", "unresolved");
  // An unbound situation of another feed: it must not create a `binding` key.
  await insertSituation("1", "nl-ndw-events");
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

async function withApp<T>(fn: (app: ReturnType<typeof Fastify>) => Promise<T>): Promise<T> {
  const app = Fastify();
  registerPublishRoutes(app, sql, new FeedStatusStore(), REPO_CATALOG);
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
  it("reports attempted and unattempted situations over the same live cohort", async () => {
    await withApp(async (app) => {
      const body = await feedsStatus(app);
      const autobahn = body.feeds.find((f) => f.id === "de-autobahn-events");
      expect(autobahn?.binding).toEqual({
        activeEvents: 2,
        attempted: 2,
        attemptedCurrent: 2,
        unattempted: 0,
        obsolete: 0,
        unattemptedOrObsolete: 0,
        unknownStatus: 0,
        exact: 1,
        likely: 0,
        ambiguous: 0,
        unresolved: 1,
        noCoverage: 0,
        notApplicable: 0,
      });
      const ndw = body.feeds.find((f) => f.id === "nl-ndw-events");
      expect(ndw).toBeTruthy();
      expect(ndw?.binding).toMatchObject({
        activeEvents: 1,
        attemptedCurrent: 0,
        unattemptedOrObsolete: 1,
      });
    });
  });

  it("serves the cached counts within the TTL and refreshes once it lapses", async () => {
    await withApp(async (app) => {
      const first = await feedsStatus(app);
      expect(first.feeds.find((f) => f.id === "de-autobahn-events")?.binding?.attempted).toBe(2);

      await insertSituation("3", "de-autobahn-events");
      await insertBinding("de-autobahn-events", "3", "likely");

      const second = await feedsStatus(app);
      expect(second.feeds.find((f) => f.id === "de-autobahn-events")?.binding).toEqual({
        activeEvents: 2,
        attempted: 2,
        attemptedCurrent: 2,
        unattempted: 0,
        obsolete: 0,
        unattemptedOrObsolete: 0,
        unknownStatus: 0,
        exact: 1,
        likely: 0,
        ambiguous: 0,
        unresolved: 1,
        noCoverage: 0,
        notApplicable: 0,
      });
    });

    // A reader whose TTL has already lapsed re-queries and sees the third situation.
    const fresh = createBindingMetricsReader(sql, 0);
    expect((await fresh()).get("de-autobahn-events")).toEqual({
      activeEvents: 3,
      attempted: 3,
      attemptedCurrent: 3,
      unattempted: 0,
      obsolete: 0,
      unattemptedOrObsolete: 0,
      unknownStatus: 0,
      exact: 1,
      likely: 1,
      ambiguous: 0,
      unresolved: 1,
      noCoverage: 0,
      notApplicable: 0,
    });
  });

  it("counts an unknown status toward attempted without inventing a key", async () => {
    await insertSituation("weird", "de-autobahn-events");
    await insertBinding("de-autobahn-events", "weird", "something_new");
    const reader = createBindingMetricsReader(sql, 0);
    const metrics = await reader();
    expect(metrics.get("de-autobahn-events")).toEqual({
      activeEvents: 4,
      attempted: 4,
      attemptedCurrent: 4,
      unattempted: 0,
      obsolete: 0,
      unattemptedOrObsolete: 0,
      unknownStatus: 1,
      exact: 1,
      likely: 1,
      ambiguous: 0,
      unresolved: 1,
      noCoverage: 0,
      notApplicable: 0,
    });
    await sql`UPDATE conditions.situation SET tombstoned_at = now(), tombstone_reason = 'withdrawn'
      WHERE id = ${id("de-autobahn-events", "weird")}`;
  });

  it("counts obsolete bindings outside attemptedCurrent", async () => {
    await sql`UPDATE conditions.record_binding SET status = 'obsolete'
      WHERE record_id = ${id("de-autobahn-events", "2")}`;
    const metrics = (await createBindingMetricsReader(sql, 0)()).get("de-autobahn-events");
    expect(metrics).toMatchObject({
      activeEvents: 3,
      attemptedCurrent: 2,
      obsolete: 1,
      unattemptedOrObsolete: 1,
    });
    expect(metrics!.activeEvents).toBe(metrics!.attemptedCurrent + metrics!.unattemptedOrObsolete);
  });

  it("treats a binding of an older revision or graph generation as obsolete", async () => {
    await insertSituation("stale-graph", "de-autobahn-events");
    await insertBinding("de-autobahn-events", "stale-graph", "exact", false);
    await insertSituation("stale-revision", "de-autobahn-events");
    await insertBinding("de-autobahn-events", "stale-revision", "exact");
    await sql`UPDATE conditions.record_binding SET record_revision = 0
      WHERE record_id = ${id("de-autobahn-events", "stale-revision")}`;
    const metrics = (await createBindingMetricsReader(sql, 0)()).get("de-autobahn-events");
    expect(metrics).toMatchObject({
      activeEvents: 5,
      attemptedCurrent: 2,
      obsolete: 3,
      unattemptedOrObsolete: 3,
      exact: 1,
    });
    expect(metrics!.activeEvents).toBe(metrics!.attemptedCurrent + metrics!.unattemptedOrObsolete);
  });

  it("leaves a withdrawn situation out of the cohort", async () => {
    await writeSituations(sql, "nl-ndw-events", [], "2026-09-06T10:05:00.000Z");
    const metrics = await createBindingMetricsReader(sql, 0)();
    expect(metrics.get("nl-ndw-events")).toBeUndefined();
  });
});
