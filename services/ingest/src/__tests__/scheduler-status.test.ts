import { describe, expect, it, vi } from "vitest";
import { FeedStatusStore } from "../feed-status.js";
import { runFeedOnce } from "../scheduler.js";
import type { DomainFeedSource } from "../pipeline/run.js";

const feed = { id: "demo", domain: "roads" } as unknown as DomainFeedSource;

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
      }
    );
    expect(store.get("demo")).toMatchObject({
      lastRowCount: 7,
      lastDurationMs: 500,
      lastSuccessAt: "2026-07-01T00:00:00.000Z",
    });
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
});
