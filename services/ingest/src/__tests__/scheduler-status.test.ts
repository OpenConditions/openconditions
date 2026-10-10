import { missingCredentials } from "@openconditions/ingest-framework";
import { describe, expect, it, vi } from "vitest";
import { FeedStatusStore } from "../feed-status.js";
import { upsertSourceStatus } from "../pipeline/source-status.js";
import { createBindingDrain, runFeedOnce, scheduleFeed } from "../scheduler.js";
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
    const bindingDrain = { request: vi.fn() };
    await runFeedOnce(feed, { sql: {} as never, fetch, now: () => "x" }, store, {
      runSource: vi.fn(async () => ({ count: 0, durationMs: 0, notDue: true as const })),
      bindingDrain,
      now: () => "2026-07-01T00:00:00.000Z",
    });
    expect(store.get("demo")).toBeUndefined();
    expect(bindingDrain.request).not.toHaveBeenCalled();
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

  it("asks for the binding queue's drain after a validated unchanged event poll", async () => {
    const store = new FeedStatusStore();
    const bindingDrain = { request: vi.fn() };
    await runFeedOnce(feed, { sql: {} as never, fetch, now: () => "x" }, store, {
      runSource: vi.fn(async () => ({
        count: 0,
        durationMs: 8,
        outcome: "validated_unchanged" as const,
      })),
      bindingDrain,
      now: () => "2026-09-11T10:00:00.000Z",
    });
    expect(bindingDrain.request).toHaveBeenCalledOnce();
  });
});

describe("createBindingDrain", () => {
  /** A drain that runs until the test lets it finish. */
  function controlled() {
    const finish: (() => void)[] = [];
    let running = 0;
    let most = 0;
    const drain = vi.fn(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => finish.push(resolve));
      running--;
    });
    const next = async () => {
      await vi.waitFor(() => expect(finish.length).toBeGreaterThan(0));
      finish.shift()!();
    };
    return { drain, next, most: () => most };
  }

  it("drains one at a time, and serves the requests made meanwhile with one more drain", async () => {
    const { drain, next, most } = controlled();
    const inFlight = new InFlight();
    const bindingDrain = createBindingDrain(drain, inFlight);
    bindingDrain.request();
    bindingDrain.request();
    bindingDrain.request();
    await next();
    await next();
    await inFlight.done;
    expect(drain).toHaveBeenCalledTimes(2);
    expect(most()).toBe(1);
  });

  it("keeps draining on request after a drain fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inFlight = new InFlight();
    const failure = new Error("deadlock detected");
    const drain = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const bindingDrain = createBindingDrain(drain, inFlight);
    try {
      bindingDrain.request();
      await inFlight.done;
      bindingDrain.request();
      await inFlight.done;
      expect(drain).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith("[scheduler] binding queue drain failed", failure);
    } finally {
      warn.mockRestore();
    }
  });

  it("starts no drain once stopped, the one under way finishing", async () => {
    const { drain, next } = controlled();
    const inFlight = new InFlight();
    const bindingDrain = createBindingDrain(drain, inFlight);
    bindingDrain.request();
    bindingDrain.request();
    bindingDrain.stop();
    await next();
    await inFlight.done;
    bindingDrain.request();
    await inFlight.done;
    expect(drain).toHaveBeenCalledOnce();
  });
});
