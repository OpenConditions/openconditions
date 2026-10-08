import { describe, expect, it } from "vitest";
import { historyDaysFromEnv, windowedRuns } from "../record-jobs.js";

describe("historyDaysFromEnv", () => {
  it("keeps tombstoned records 90 days unless told otherwise", () => {
    expect(historyDaysFromEnv({})).toBe(90);
    expect(historyDaysFromEnv({ OPENCONDITIONS_HISTORY_DAYS: "" })).toBe(90);
    expect(historyDaysFromEnv({ OPENCONDITIONS_HISTORY_DAYS: "30" })).toBe(30);
  });

  it("ignores a value that is not a whole number of days", () => {
    expect(historyDaysFromEnv({ OPENCONDITIONS_HISTORY_DAYS: "0" })).toBe(90);
    expect(historyDaysFromEnv({ OPENCONDITIONS_HISTORY_DAYS: "2.5" })).toBe(90);
    expect(historyDaysFromEnv({ OPENCONDITIONS_HISTORY_DAYS: "forever" })).toBe(90);
  });
});

describe("windowedRuns", () => {
  it("covers the hour before its first run, then the time since the last good one", async () => {
    const windows: { from: string; to: string }[] = [];
    let fail = false;
    let clock = new Date("2026-10-08T10:00:00Z");
    const run = windowedRuns(
      async (window) => {
        windows.push(window);
        if (fail) throw new Error("database away");
        return 0;
      },
      () => clock,
    );
    await run();
    clock = new Date("2026-10-08T10:05:00Z");
    fail = true;
    await expect(run()).rejects.toThrow();
    clock = new Date("2026-10-08T10:10:00Z");
    fail = false;
    await run();
    expect(windows).toEqual([
      { from: "2026-10-08T09:00:00.000Z", to: "2026-10-08T10:00:00.000Z" },
      { from: "2026-10-08T10:00:00.000Z", to: "2026-10-08T10:05:00.000Z" },
      // The failed run's window is covered again.
      { from: "2026-10-08T10:00:00.000Z", to: "2026-10-08T10:10:00.000Z" },
    ]);
  });
});
