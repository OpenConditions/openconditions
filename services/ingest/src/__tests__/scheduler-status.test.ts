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
