import type { FederationReconcileCounts } from "@openconditions/storage";
import { describe, expect, it, vi } from "vitest";
import { type FederationReconcile, startFederationReconcile } from "../federation-reconcile.js";
import { startFusedRefresh } from "../fused-refresh.js";
import { shutdown } from "../shutdown.js";

const counts = (over: Partial<FederationReconcileCounts> = {}): FederationReconcileCounts => ({
  sources: [],
  journalled: 0,
  settled: [],
  ...over,
});

const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe("startFederationReconcile", () => {
  it("logs a failed reconcile and keeps the service running", async () => {
    const log = logger();
    const failure = new Error("connection lost");
    const handle = startFederationReconcile(async () => {
      throw failure;
    }, log);
    await expect(handle.done).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      "[ingest] federation reconcile failed; the next boot resumes it:",
      failure,
    );
  });

  it("reports a reconcile stopped at shutdown as stopped", async () => {
    const log = logger();
    let resolveBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => {
      resolveBatch = resolve;
    });
    const reconcile: FederationReconcile = async ({ signal, onStart, onBatch }) => {
      onStart?.({ sources: ["a", "b"] });
      let journalled = 0;
      while (signal?.aborted !== true && journalled < 8) {
        journalled += 2;
        onBatch?.({ source: "a", journalled });
        resolveBatch();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return counts({ sources: ["a", "b"], settled: ["a"], journalled });
    };
    const handle = startFederationReconcile(reconcile, log);
    await firstBatch;
    handle.stop();
    await handle.done;
    const lines = log.info.mock.calls.map((c) => c[0] as string);
    expect(lines[0]).toBe(
      "[ingest] federation outbox outdated for 2 source(s) (a, b): reconciling",
    );
    expect(lines[1]).toBe("[ingest] federation reconcile: 2 entries journalled (a)");
    expect(lines.at(-1)).toMatch(
      /^\[ingest\] federation reconcile stopped in \d+s: 2 entries journalled; 1\/2 source\(s\) settled$/,
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs nothing when every source is in sync", async () => {
    const log = logger();
    await startFederationReconcile(async ({ onStart }) => {
      onStart?.({ sources: [] });
      return counts();
    }, log).done;
    expect(log.info).not.toHaveBeenCalled();
  });

  it("lists at most ten sources", async () => {
    const log = logger();
    const sources = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, "0")}`);
    await startFederationReconcile(async ({ onStart }) => {
      onStart?.({ sources });
      return counts({ sources, settled: sources });
    }, log).done;
    expect(log.info.mock.calls[0]![0]).toBe(
      "[ingest] federation outbox outdated for 12 source(s) " +
        "(s00, s01, s02, s03, s04, s05, s06, s07, s08, s09, +2 more): reconciling",
    );
    expect(log.info.mock.calls.at(-1)![0]).toMatch(
      /^\[ingest\] federation reconcile done in \d+s: 0 entries journalled; 12\/12 source\(s\) settled$/,
    );
  });
});

describe("shutdown", () => {
  it("stops the fusion refresh and the federation reconcile, and closes the database after both", async () => {
    const log = logger();
    let ended = false;
    const job = async (signal: AbortSignal | undefined) => {
      while (signal?.aborted !== true) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (ended) throw new Error("connection ended");
      }
    };
    const fusedRefresh = startFusedRefresh(async ({ signal }) => {
      await job(signal);
      return {
        sources: [],
        settled: [],
        features: 0,
        total: 0,
        written: 0,
        unchanged: 0,
        deleted: 0,
      };
    }, log);
    const reconcile = startFederationReconcile(async ({ signal }) => {
      await job(signal);
      return counts();
    }, log);
    await shutdown({
      stop: [],
      background: [fusedRefresh, reconcile],
      app: { close: async () => undefined },
      sql: {
        end: async () => {
          ended = true;
        },
      },
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs a batch the budget cut short as stopped at shutdown, not as a failure", async () => {
    const log = logger();
    let ended = false;
    let batchStarted!: () => void;
    const inBatch = new Promise<void>((resolve) => {
      batchStarted = resolve;
    });
    const reconcile = startFederationReconcile(async ({ onStart }) => {
      onStart?.({ sources: ["a"] });
      batchStarted();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (ended) throw new Error("write CONNECTION_ENDED");
      return counts({ sources: ["a"], settled: ["a"] });
    }, log);
    await inBatch;
    await shutdown({
      stop: [],
      background: [reconcile],
      app: { close: async () => undefined },
      sql: {
        end: async () => {
          ended = true;
        },
      },
      budgetMs: 10,
    });
    await reconcile.done;
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info.mock.calls.at(-1)).toEqual([
      "[ingest] federation reconcile stopped at shutdown; the next boot resumes it:",
      "write CONNECTION_ENDED",
    ]);
  });
});
