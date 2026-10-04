import { missingCredentials } from "@openconditions/ingest-framework";
import { describe, expect, it, vi } from "vitest";
import { FeedStatusStore } from "../feed-status.js";
import { upsertSourceStatus } from "../pipeline/source-status.js";
import { runFeedOnce, scheduleFeed } from "../scheduler.js";
import { InFlight } from "../shutdown.js";
import { repoFeed, testFeed } from "./helpers/catalog.js";

vi.mock("../pipeline/source-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pipeline/source-status.js")>()),
  upsertSourceStatus: vi.fn(async () => {}),
}));

const feed = testFeed({ id: "demo" });

describe("scheduleFeed", () => {
  it("a feed without its credential is skipped with the env var named", async () => {
    const ohgo = repoFeed("us-oh-ohgo-flow");
    const fetchSpy = vi.fn();
    const sql = {} as never;
    const job = scheduleFeed(ohgo, {
      sql,
      statusStore: new FeedStatusStore(),
      deps: { sql, fetch: fetchSpy, now: () => "2026-10-03T00:00:00.000Z" },
      env: {},
    });

    expect(job).toBeUndefined();
    expect(missingCredentials(ohgo, {})).toEqual(["US_OH_OHGO_API_KEY"]);
    expect(upsertSourceStatus).toHaveBeenCalledWith(
      sql,
      "us-oh-ohgo-flow",
      expect.objectContaining({
        outcome: "missing_configuration",
        error: "missing required configuration: US_OH_OHGO_API_KEY",
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never polls an on-demand feed: reads fetch its cells", () => {
    const sql = {} as never;
    const fetchSpy = vi.fn();
    const job = scheduleFeed(repoFeed("osm-fuel"), {
      sql,
      statusStore: new FeedStatusStore(),
      deps: { sql, fetch: fetchSpy, now: () => "2026-10-03T00:00:00.000Z" },
      env: {},
    });
    expect(job).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("schedules a feed once its credential is set", () => {
    const sql = {} as never;
    const job = scheduleFeed(repoFeed("us-oh-ohgo-flow"), {
      sql,
      statusStore: new FeedStatusStore(),
      deps: { sql, fetch: vi.fn(), now: () => "2026-10-03T00:00:00.000Z" },
      env: { US_OH_OHGO_API_KEY: "key" },
    });
    try {
      expect(job).toBeDefined();
    } finally {
      job?.stop();
    }
  });

  it("tracks each poll in flight, so shutdown waits for it", async () => {
    const sql = {} as never;
    const inFlight = new InFlight();
    const track = vi.spyOn(inFlight, "track");
    const job = scheduleFeed(repoFeed("us-oh-ohgo-flow"), {
      sql,
      statusStore: new FeedStatusStore(),
      deps: { sql, fetch: vi.fn(), now: () => "2026-10-03T00:00:00.000Z" },
      env: { US_OH_OHGO_API_KEY: "key" },
      inFlight,
    });
    try {
      await job!.trigger();
      expect(track).toHaveBeenCalledOnce();
      await inFlight.done;
    } finally {
      job?.stop();
    }
  });
});

describe("runFeedOnce", () => {
  it("records success with the run's row count + duration", async () => {
    const store = new FeedStatusStore();
    const runSource = vi.fn(async () => ({ count: 7, durationMs: 500 }));
    await runFeedOnce(
      feed,
      { sql: {} as never, fetch, now: () => "2026-07-01T00:00:00.000Z" },
      store,
      {
        runSource,
        now: () => "2026-07-01T00:00:00.000Z",
      },
    );
    expect(store.get("demo")).toMatchObject({
      lastRowCount: 7,
      lastDurationMs: 500,
      lastSuccessAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("records nothing when no endpoint was due, success or otherwise", async () => {
    const store = new FeedStatusStore();
    const drainBindingQueue = vi.fn();
    await runFeedOnce(feed, { sql: {} as never, fetch, now: () => "x" }, store, {
      runSource: vi.fn(async () => ({ count: 0, durationMs: 0, notDue: true as const })),
      drainBindingQueue,
      now: () => "2026-07-01T00:00:00.000Z",
    });
    expect(store.get("demo")).toBeUndefined();
    expect(drainBindingQueue).not.toHaveBeenCalled();
  });

  it("records an error when the run throws", async () => {
    const store = new FeedStatusStore();
    const runSource = vi.fn(async () => {
      throw new Error("boom");
    });
    await runFeedOnce(feed, { sql: {} as never, fetch, now: () => "x" }, store, {
      runSource,
      now: () => "2026-07-01T00:05:00.000Z",
    });
    expect(store.get("demo")).toMatchObject({
      lastError: "boom",
      lastErrorAt: "2026-07-01T00:05:00.000Z",
    });
    expect(store.get("demo")?.lastSuccessAt).toBeUndefined();
  });

  it("records an error when the run swallows a genuine failure (result.error set)", async () => {
    const store = new FeedStatusStore();
    const runSource = vi.fn(async () => ({ count: 0, durationMs: 100, error: "HTTP 503" }));
    await runFeedOnce(feed, { sql: {} as never, fetch, now: () => "x" }, store, {
      runSource,
      now: () => "2026-07-01T00:10:00.000Z",
    });
    expect(store.get("demo")?.lastError).toBe("HTTP 503");
    expect(store.get("demo")?.lastSuccessAt).toBeUndefined();
  });
  it("records the run's per-source no-geometry skip count", async () => {
    const store = new FeedStatusStore();
    const runSource = vi.fn(async () => ({ count: 40, durationMs: 120, skippedNoGeometry: 11 }));
    await runFeedOnce(feed, { sql: {} as never, fetch, now: () => "x" }, store, {
      runSource,
      now: () => "2026-07-01T00:10:00.000Z",
    });
    expect(store.get("demo")?.lastSkippedNoGeometry).toBe(11);
  });

  it("clears a previous run's skip count when the next run drops nothing", async () => {
    const store = new FeedStatusStore();
    const deps = { sql: {} as never, fetch, now: () => "x" };
    await runFeedOnce(feed, deps, store, {
      runSource: vi.fn(async () => ({ count: 40, durationMs: 120, skippedNoGeometry: 11 })),
      now: () => "2026-07-01T00:10:00.000Z",
    });
    await runFeedOnce(feed, deps, store, {
      runSource: vi.fn(async () => ({ count: 51, durationMs: 130 })),
      now: () => "2026-07-01T00:15:00.000Z",
    });
    expect(store.get("demo")?.lastSkippedNoGeometry).toBeUndefined();
  });

  it("drains durable binding work after a validated unchanged event poll", async () => {
    const store = new FeedStatusStore();
    let drained = 0;
    await runFeedOnce(feed, { sql: {} as never, fetch, now: () => "x" }, store, {
      runSource: vi.fn(async () => ({
        count: 0,
        durationMs: 8,
        outcome: "validated_unchanged" as const,
      })),
      drainBindingQueue: async () => {
        drained++;
        return { attempted: 0, bound: 0, retained: 0 } as never;
      },
      now: () => "2026-09-11T10:00:00.000Z",
    });
    expect(drained).toBe(1);
  });
});
