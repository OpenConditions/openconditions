import { describe, expect, it, vi } from "vitest";
import { InFlight, onceShutdown, shutdown } from "../shutdown.js";

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("InFlight", () => {
  it("settles once every tracked task has, including one tracked while it waits", async () => {
    const work = new InFlight();
    const order: string[] = [];
    void work.track(later(20).then(() => order.push("first")));
    const done = work.done.then(() => order.push("done"));
    await later(5);
    void work.track(later(30).then(() => order.push("second")));
    await done;
    expect(order).toEqual(["first", "second", "done"]);
  });

  it("returns the tracked work, and a failed one still settles the job", async () => {
    const work = new InFlight();
    await expect(work.track(Promise.resolve(7))).resolves.toBe(7);
    await expect(work.track(Promise.reject(new Error("upstream down")))).rejects.toThrow(
      "upstream down",
    );
    await expect(work.done).resolves.toBeUndefined();
  });
});

describe("shutdown", () => {
  it("waits for in-flight work before every database pool closes", async () => {
    const work = new InFlight();
    const order: string[] = [];
    void work.track(later(30).then(() => order.push("cell written")));
    await shutdown({
      stop: [],
      background: [work],
      app: { close: async () => order.push("server closed") },
      databases: [
        { end: async () => order.push("writer pool closed") },
        { end: async () => order.push("reader pool closed") },
      ],
    });
    expect(order).toEqual([
      "server closed",
      "cell written",
      "writer pool closed",
      "reader pool closed",
    ]);
  });

  it("stops waiting for in-flight work at the budget", async () => {
    const work = new InFlight();
    void work.track(new Promise(() => undefined));
    const end = vi.fn(async () => undefined);
    const started = Date.now();
    await shutdown({
      stop: [],
      background: [work],
      app: { close: async () => undefined },
      databases: [{ end }],
      budgetMs: 50,
    });
    expect(end).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("runs once: a second signal is a no-op, and a failure is logged, never rejected", async () => {
    const close = vi.fn(async () => undefined);
    const failure = new Error("connection already closed");
    const log = { error: vi.fn() };
    const stop = onceShutdown(
      {
        stop: [],
        background: [],
        app: { close },
        databases: [
          {
            end: async () => {
              throw failure;
            },
          },
        ],
      },
      log,
    );
    const first = stop();
    const second = stop();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith("[ingest] shutdown failed:", failure);
  });
});
