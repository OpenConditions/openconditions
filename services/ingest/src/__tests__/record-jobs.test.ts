import { describe, expect, it } from "vitest";
import { historyDaysFromEnv } from "../record-jobs.js";

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
