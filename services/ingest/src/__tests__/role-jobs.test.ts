import { productionRegistry } from "@openconditions/model-registry";
import * as storage from "@openconditions/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedStatusStore } from "../feed-status.js";
import { rebindOnBoot } from "../pipeline/rebind.js";
import { refreshSegmentSpeed } from "../pipeline/segment-speed.js";
import { pruneSourcePollAttempts } from "../pipeline/source-status.js";
import { evictRawPayloads } from "../raw/evict.js";
import { startRecordJobs } from "../record-jobs.js";
import { startScheduler } from "../scheduler.js";
import { REPO_CATALOG } from "./helpers/catalog.js";

vi.mock("@openconditions/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openconditions/storage")>()),
  ensureObservationPartitions: vi.fn(async () => []),
  dropExpiredObservationPartitions: vi.fn(async () => []),
  rollupObservations: vi.fn(async () => ({ rows: 0 })),
  pruneRollups: vi.fn(async () => {}),
  sweepRecords: vi.fn(async () => ({})),
  refreshFlippedFusions: vi.fn(async () => 0),
}));
vi.mock("../raw/evict.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../raw/evict.js")>()),
  evictRawPayloads: vi.fn(async () => ({ evict: [], purged: 0, rung: 0, hotEvicted: [] })),
}));
vi.mock("../pipeline/segment-speed.js", () => ({ refreshSegmentSpeed: vi.fn(async () => {}) }));
vi.mock("../pipeline/rebind.js", () => ({ rebindOnBoot: vi.fn(async () => ({ rebound: 0 })) }));
vi.mock("../pipeline/source-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pipeline/source-status.js")>()),
  pruneSourcePollAttempts: vi.fn(async () => ({ deleted: 0 })),
}));

const sql = {} as never;
const maintenanceSql = {} as never;
const HOUR_MS = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-15T00:00:30Z") });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs the jobs `start` starts through an hour, then stops them. */
async function anHourOf(start: () => () => void): Promise<void> {
  const stop = start();
  try {
    await vi.advanceTimersByTimeAsync(HOUR_MS);
  } finally {
    stop();
  }
}

describe("the record jobs", () => {
  const options = { registry: productionRegistry(), instanceId: "local", env: {} };

  it("all run on the primary, which evicts every source's raw payloads but those it leaves", async () => {
    const scope = { except: ["nl-ndw-flow"] };
    await anHourOf(() =>
      startRecordJobs(sql, maintenanceSql, { ...options, primary: true, scope }),
    );
    expect(storage.ensureObservationPartitions).toHaveBeenCalled();
    expect(storage.rollupObservations).toHaveBeenCalled();
    expect(storage.sweepRecords).toHaveBeenCalled();
    expect(storage.refreshFlippedFusions).toHaveBeenCalled();
    expect(evictRawPayloads).toHaveBeenCalledWith(
      maintenanceSql,
      expect.objectContaining({ scope }),
    );
  });

  it("leave a feeds process only the eviction of its own raw payloads", async () => {
    const scope = { only: ["nl-ndw-flow"] };
    await anHourOf(() =>
      startRecordJobs(sql, maintenanceSql, { ...options, primary: false, scope }),
    );
    expect(storage.ensureObservationPartitions).not.toHaveBeenCalled();
    expect(storage.dropExpiredObservationPartitions).not.toHaveBeenCalled();
    expect(storage.rollupObservations).not.toHaveBeenCalled();
    expect(storage.sweepRecords).not.toHaveBeenCalled();
    expect(storage.refreshFlippedFusions).not.toHaveBeenCalled();
    expect(evictRawPayloads).toHaveBeenCalledWith(
      maintenanceSql,
      expect.objectContaining({ scope }),
    );
  });
});

describe("the scheduler", () => {
  const start = (primary: boolean) => () =>
    startScheduler(sql, maintenanceSql, new FeedStatusStore(), REPO_CATALOG, {
      feeds: [],
      primary,
    });

  it("runs the segment refresh, poll-history pruning and boot rebind on the primary", async () => {
    await anHourOf(start(true));
    expect(rebindOnBoot).toHaveBeenCalledOnce();
    expect(refreshSegmentSpeed).toHaveBeenCalled();
    expect(pruneSourcePollAttempts).toHaveBeenCalled();
  });

  it("runs none of them on a feeds process", async () => {
    await anHourOf(start(false));
    expect(rebindOnBoot).not.toHaveBeenCalled();
    expect(refreshSegmentSpeed).not.toHaveBeenCalled();
    expect(pruneSourcePollAttempts).not.toHaveBeenCalled();
  });
});
