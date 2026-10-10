import type { OutdatedRefreshCounts } from "@openconditions/storage";
import { describe, expect, it, vi } from "vitest";
import { type OutdatedRefresh, startFusedRefresh } from "../fused-refresh.js";
import { shutdown } from "../shutdown.js";

const counts = (over: Partial<OutdatedRefreshCounts> = {}): OutdatedRefreshCounts => ({
  sources: [],
  settled: [],
  features: 0,
  total: 0,
  written: 0,
  unchanged: 0,
  deleted: 0,
  ...over,
});

const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe("startFusedRefresh", () => {
  it("logs a failed refresh and keeps the service running", async () => {
    const log = logger();
    const failure = new Error("connection lost");
    const handle = startFusedRefresh(async () => {
      throw failure;
    }, log);
    await expect(handle.done).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      "[ingest] fusion refresh failed; the next boot resumes it:",
      failure,
    );
  });

  it("reports a refresh stopped at shutdown as stopped", async () => {
    const log = logger();
    let resolveBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => {
      resolveBatch = resolve;
    });
    const refresh: OutdatedRefresh = async ({ signal, onStart, onBatch }) => {
      onStart?.({ sources: ["a", "b"], total: 4 });
      let done = 0;
      while (signal?.aborted !== true && done < 4) {
        done += 1;
        onBatch?.({ done, total: 4 });
        resolveBatch();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return counts({ sources: ["a", "b"], settled: ["a"], features: done, total: 4 });
    };
    const handle = startFusedRefresh(refresh, log);
    await firstBatch;
    handle.stop();
    await handle.done;
    const lines = log.info.mock.calls.map((c) => c[0] as string);
    expect(lines[0]).toBe(
      "[ingest] fusions outdated for 2 source(s) (a, b): refreshing 4 canonical feature(s)",
    );
    expect(lines[1]).toBe("[ingest] fusion refresh: 1/4 canonical features");
    expect(lines.at(-1)).toMatch(
      /^\[ingest\] fusion refresh stopped in \d+s: 1\/4 canonical features, .* 1\/2 source\(s\) settled$/,
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs nothing when no fusion is outdated", async () => {
    const log = logger();
    await startFusedRefresh(async ({ onStart }) => {
      onStart?.({ sources: [], total: 0 });
      return counts();
    }, log).done;
    expect(log.info).not.toHaveBeenCalled();
  });

  it("logs nothing when the outdated sources have no canonical feature to refresh", async () => {
    const log = logger();
    await startFusedRefresh(async ({ onStart }) => {
      onStart?.({ sources: ["a", "b"], total: 0 });
      return counts({ sources: ["a", "b"], settled: ["a", "b"] });
    }, log).done;
    expect(log.info).not.toHaveBeenCalled();
  });

  it("lists at most ten outdated sources", async () => {
    const log = logger();
    const sources = Array.from({ length: 13 }, (_, i) => `s${String(i).padStart(2, "0")}`);
    await startFusedRefresh(async ({ onStart }) => {
      onStart?.({ sources, total: 20 });
      return counts({ sources, settled: sources, features: 20, total: 20 });
    }, log).done;
    expect(log.info.mock.calls[0]![0]).toBe(
      "[ingest] fusions outdated for 13 source(s) " +
        "(s00, s01, s02, s03, s04, s05, s06, s07, s08, s09, +3 more): " +
        "refreshing 20 canonical feature(s)",
    );
  });
});

describe("shutdown", () => {
  it("lets a refresh stopped during a batch finish it before the database closes", async () => {
    const log = logger();
    let ended = false;
    let batchStarted!: () => void;
    const inBatch = new Promise<void>((resolve) => {
      batchStarted = resolve;
    });
    const refresh: OutdatedRefresh = async ({ signal, onStart }) => {
      onStart?.({ sources: ["a"], total: 2 });
      let done = 0;
      while (signal?.aborted !== true && done < 2) {
        batchStarted();
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (ended) throw new Error("connection ended");
        done += 1;
      }
      return counts({ sources: ["a"], features: done, total: 2 });
    };
    const fusedRefresh = startFusedRefresh(refresh, log);
    await inBatch;
    await shutdown({
      stop: [],
      background: [fusedRefresh],
      app: { close: async () => undefined },
      databases: [
        {
          end: async () => {
            ended = true;
          },
        },
      ],
    });
    await fusedRefresh.done;
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info.mock.calls.at(-1)![0]).toMatch(/^\[ingest\] fusion refresh stopped in/);
  });

  it("logs a batch the budget cut short as stopped at shutdown, not as a failure", async () => {
    const log = logger();
    let ended = false;
    let batchStarted!: () => void;
    const inBatch = new Promise<void>((resolve) => {
      batchStarted = resolve;
    });
    const fusedRefresh = startFusedRefresh(async ({ onStart }) => {
      onStart?.({ sources: ["a"], total: 2 });
      batchStarted();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (ended) throw new Error("write CONNECTION_ENDED");
      return counts({ sources: ["a"], features: 2, total: 2 });
    }, log);
    await inBatch;
    await shutdown({
      stop: [],
      background: [fusedRefresh],
      app: { close: async () => undefined },
      databases: [
        {
          end: async () => {
            ended = true;
          },
        },
      ],
      budgetMs: 10,
    });
    await fusedRefresh.done;
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info.mock.calls.at(-1)).toEqual([
      "[ingest] fusion refresh stopped at shutdown; the next boot resumes it:",
      "write CONNECTION_ENDED",
    ]);
  });
});
