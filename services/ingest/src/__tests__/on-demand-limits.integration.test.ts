import { ensureObservationPartitions, retentionClasses } from "@openconditions/storage";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { takeCellTokens } from "../on-demand/limits.js";
import { readThrough } from "../on-demand/read-through.js";
import { fakeLookup, onDemandFeed, registry, START, upstream } from "./helpers/on-demand.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

vi.mock("../domains.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../domains.js")>();
  const { testDomain: domain } = await import("./helpers/on-demand.js");
  const isTest = (feed: { domain: string }) => feed.domain === "fuel";
  return {
    ...original,
    domainOf: (feed: Parameters<typeof original.domainOf>[0]) =>
      isTest(feed) ? domain : original.domainOf(feed),
    formatOf: (feed: Parameters<typeof original.formatOf>[0]) =>
      isTest(feed) ? domain.formats[feed.format]! : original.formatOf(feed),
  };
});

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, { classes: retentionClasses(registry), now: START });
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);

/** Three cells of 0.1°, in id order 0.1/80/490, 0.1/81/490, 0.1/82/490. */
const THREE_CELLS: [number, number, number, number] = [8, 49, 8.3, 49.1];

describe("on-demand request limits", () => {
  test("perMinute limits fetches and reports the rest as limited", async () => {
    const feed = onDemandFeed("perminute", { requestLimits: { perMinute: 1 } });
    const up = upstream();
    const clock = { now: START };
    const read = () =>
      readThrough(
        sql,
        { feeds: [feed] },
        { bbox: THREE_CELLS, class: "feature", kinds: ["fuel_station"], scope: "public" },
        {
          fetch: up.fetch,
          now: () => clock.now,
          deadlineMs: 5000,
          registry,
          instanceId: "test.local",
          lookup: fakeLookup,
        },
      );
    const fetchedCells = async () =>
      (
        await sql<{ cell: string }[]>`
          SELECT cell FROM conditions.on_demand_fetch
           WHERE source_id = ${feed.id} AND status = 'fresh' ORDER BY cell`
      ).map((r) => r.cell);

    expect(await read()).toEqual({
      partial: true,
      sources: [{ id: feed.id, complete: false, reason: "limited" }],
    });
    expect(up.calls).toHaveLength(1);
    expect(await fetchedCells()).toEqual(["0.1/80/490"]);

    clock.now = at(30);
    await read();
    expect(up.calls).toHaveLength(1);

    clock.now = at(60);
    await read();
    expect(up.calls).toHaveLength(2);
    expect(await fetchedCells()).toEqual(["0.1/80/490", "0.1/81/490"]);

    // The bucket refills perMinute tokens per 60 s, never beyond perMinute.
    const bucket = onDemandFeed("bucket", { requestLimits: { perMinute: 2 } });
    expect(await takeCellTokens(sql, bucket, at(0))).toBe(true);
    expect(await takeCellTokens(sql, bucket, at(0))).toBe(true);
    expect(await takeCellTokens(sql, bucket, at(0))).toBe(false);
    expect(await takeCellTokens(sql, bucket, at(30))).toBe(true);
    expect(await takeCellTokens(sql, bucket, at(30))).toBe(false);
    expect(await takeCellTokens(sql, bucket, at(3600))).toBe(true);
    expect(await takeCellTokens(sql, bucket, at(3600))).toBe(true);
    expect(await takeCellTokens(sql, bucket, at(3600))).toBe(false);

    // An absent limit does not limit.
    const unlimited = onDemandFeed("unlimited");
    for (let i = 0; i < 10; i++) expect(await takeCellTokens(sql, unlimited, at(0))).toBe(true);
  }, 60_000);

  test("a cell takes one request of the limit per URL of its data endpoint", async () => {
    const feed = onDemandFeed("multiurl", {
      endpoints: {
        main: {
          urls: [
            "https://example.test/multiurl/a?w={west}&s={south}&e={east}&n={north}",
            "https://example.test/multiurl/b?w={west}&s={south}&e={east}&n={north}",
          ],
          cadenceSec: 900,
        },
      },
      requestLimits: { perMinute: 3 },
    });
    const up = upstream();
    up.answerEmpty(true);
    const coverage = await readThrough(
      sql,
      { feeds: [feed] },
      { bbox: THREE_CELLS, class: "feature", kinds: ["fuel_station"], scope: "public" },
      {
        fetch: up.fetch,
        now: () => START,
        deadlineMs: 5000,
        registry,
        instanceId: "test.local",
        lookup: fakeLookup,
      },
    );
    // Three requests a minute: the first cell's two, and none left for a second cell.
    expect(coverage).toEqual({
      partial: true,
      sources: [{ id: feed.id, complete: false, reason: "limited" }],
    });
    expect(up.calls.map((u) => u.pathname)).toEqual(["/multiurl/a", "/multiurl/b"]);
  }, 60_000);

  test("perDay survives a restart because it is counted in the database", async () => {
    const feed = onDemandFeed("perday", { requestLimits: { perDay: 2 } });
    const day = new Date("2026-10-03T23:59:00.000Z");
    expect(await takeCellTokens(sql, feed, day)).toBe(true);
    expect(await takeCellTokens(sql, feed, day)).toBe(true);
    expect(await takeCellTokens(sql, feed, day)).toBe(false);

    // A restarted service (a fresh module and connection pool) counts on.
    vi.resetModules();
    const restarted = await import("../on-demand/limits.js");
    const restartedSql = postgres(db.url, { max: 1 });
    try {
      expect(await restarted.takeCellTokens(restartedSql, feed, day)).toBe(false);
      // The day counter resets at the UTC date change.
      const nextDay = new Date("2026-10-04T00:00:30.000Z");
      expect(await restarted.takeCellTokens(restartedSql, feed, nextDay)).toBe(true);
      expect(await restarted.takeCellTokens(restartedSql, feed, nextDay)).toBe(true);
      expect(await restarted.takeCellTokens(restartedSql, feed, nextDay)).toBe(false);
    } finally {
      await restartedSql.end();
    }
  }, 60_000);

  test("a source whose credentials are missing is not fetched and says so", async () => {
    const feed = onDemandFeed("keyed", {
      endpoints: {
        main: {
          url: "https://example.test/keyed?w={west}&s={south}&e={east}&n={north}&key=${api_key}",
          cadenceSec: 900,
        },
      },
      credentials: { api_key: { title: "API key" } },
    });
    const up = upstream();
    const read = (env: NodeJS.ProcessEnv) =>
      readThrough(
        sql,
        { feeds: [feed] },
        { bbox: [8, 49, 8.1, 49.1], class: "feature", domain: "fuel", scope: "public" },
        {
          fetch: up.fetch,
          now: () => START,
          deadlineMs: 5000,
          registry,
          instanceId: "test.local",
          lookup: fakeLookup,
          env,
        },
      );
    expect(await read({})).toEqual({
      partial: true,
      sources: [{ id: feed.id, complete: false, reason: "missing_configuration" }],
    });
    expect(up.calls).toHaveLength(0);

    expect(await read({ DE_KEYED_FUEL_API_KEY: "k-123" })).toEqual({
      partial: false,
      sources: [{ id: feed.id, complete: true }],
    });
    expect(up.calls.map((u) => u.searchParams.get("key"))).toEqual(["k-123"]);
  }, 60_000);
});
