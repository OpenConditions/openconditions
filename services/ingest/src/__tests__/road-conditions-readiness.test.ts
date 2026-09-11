import { describe, expect, it } from "vitest";
import { assessReadiness, type PollAttempt } from "../ops/road-conditions-readiness.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");

function attempt(
  attemptedAt: number,
  outcome: PollAttempt["outcome"] = "validated_unchanged",
  freshnessWindowSec = 14_400
): PollAttempt {
  return {
    source: "wzdx-kansas",
    outcome,
    attemptedAt: new Date(attemptedAt).toISOString(),
    freshnessWindowSec,
  };
}

describe("seven-day road-condition readiness", () => {
  it("excludes local skips and accepts exactly 99 percent across a gap-free seven-day soak", () => {
    const interval = (7 * 86_400_000) / 99;
    const rows = Array.from({ length: 100 }, (_, i) =>
      attempt(NOW - 7 * 86_400_000 + i * interval, i === 50 ? "failed" : "validated_unchanged")
    );
    rows.push(attempt(NOW, "skipped_cadence"), attempt(NOW, "skipped_overlap"));

    expect(assessReadiness(rows, new Date(NOW))[0]).toMatchObject({
      source: "wzdx-kansas",
      networkAttempts: 100,
      successfulValidations: 99,
      failed: 1,
      skippedCadence: 1,
      skippedOverlap: 1,
      networkReliability: 0.99,
      networkReliabilityReady: true,
      sevenDayCoverageReady: true,
      noFreshnessGaps: true,
      pollSoakReady: true,
    });
  });

  it("does not call one successful poll a seven-day soak", () => {
    const report = assessReadiness([attempt(NOW, "changed")], new Date(NOW))[0]!;
    expect(report.networkReliabilityReady).toBe(true);
    expect(report.sevenDayCoverageReady).toBe(false);
    expect(report.pollSoakReady).toBe(false);
  });

  it("fails soak coverage when successful validations contain a freshness gap", () => {
    const rows = [
      attempt(NOW - 7 * 86_400_000, "changed", 900),
      attempt(NOW - 6 * 86_400_000, "validated_unchanged", 900),
      attempt(NOW, "validated_unchanged", 900),
    ];
    const report = assessReadiness(rows, new Date(NOW))[0]!;
    expect(report.networkReliabilityReady).toBe(true);
    expect(report.noFreshnessGaps).toBe(false);
    expect(report.pollSoakReady).toBe(false);
  });
});
