import { describe, expect, it } from "vitest";
import { JOURNAL_LAG_REWARN_MS, type JournalLagWatch, journalLagNotice } from "../journal.js";

const BOUND = 300;
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

/** Runs the lag checks `lags` (seconds) a minute apart, collecting what each logs. */
function run(lags: number[]): (string | null)[] {
  let watch: JournalLagWatch = { warnedAt: null };
  return lags.map((lag, i) => {
    const decided = journalLagNotice(watch, lag, BOUND, T0 + i * 60_000);
    watch = decided.watch;
    return decided.notice;
  });
}

describe("journalLagNotice", () => {
  it("says nothing while the lag stays within the bound", () => {
    expect(run([0, 120, BOUND, 0])).toEqual([null, null, null, null]);
  });

  it("warns when the lag first exceeds the bound and once more every ten minutes", () => {
    expect(JOURNAL_LAG_REWARN_MS).toBe(10 * 60_000);
    const notices = run(Array.from({ length: 22 }, (_, i) => BOUND + 1 + i * 60));
    expect(notices.map((n, i) => (n === "warn" ? i : null)).filter((i) => i !== null)).toEqual([
      0, 10, 20,
    ]);
  });

  it("logs one recovery when the lag is back within the bound", () => {
    expect(run([BOUND + 1, BOUND + 61, 10, 0, BOUND + 5])).toEqual([
      "warn",
      null,
      "recovered",
      null,
      "warn",
    ]);
  });
});
