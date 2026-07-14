/**
 * Shared fixtures for the DP release-glue tests. Not a test file (no `.test.ts`
 * suffix), so vitest does not execute it directly — it only supplies a standard
 * manifest, params, and mechanism config so each invariant test starts from the
 * same fixed, data-independent schedule.
 */
import {
  buildReleaseManifest,
  RecordingDpMechanism,
  type ReleaseManifest,
  type ReleaseParams,
} from "../index.js";

export const HOUR_MS = 3_600_000;

/** Two public segments × two tumbling 1h windows = a fixed 4-cell grid. */
export function standardManifest(version = "manifest-v1"): ReleaseManifest {
  return buildReleaseManifest({
    version,
    segmentIds: ["seg-a", "seg-b"],
    windows: [
      { windowId: "w1", startMs: 0, endMs: HOUR_MS },
      { windowId: "w2", startMs: HOUR_MS, endMs: 2 * HOUR_MS },
    ],
  });
}

export function standardParams(overrides: Partial<ReleaseParams> = {}): ReleaseParams {
  return {
    speedLower: 0,
    speedUpper: 200,
    epsilonSum: 0.5,
    epsilonSelect: 0.1,
    deltaSelect: 1e-6,
    maxPartitionsPerUnit: 2,
    budget: { epsilon: 10, delta: 1e-3 },
    ...overrides,
  };
}

/** A release-threshold of 2 by default: a cell needs ≥2 units to survive. */
export function standardMechanism(selectThreshold = 2): RecordingDpMechanism {
  return new RecordingDpMechanism({
    sumStandIn: 42,
    selectThreshold,
    epsilonSpentPerSum: 0.5,
    epsilonSpentPerSelect: 0.1,
    deltaSpentPerSelect: 1e-6,
  });
}

/** All values passed to every recorded `boundedSum`, flattened. */
export function allSumValues(mechanism: RecordingDpMechanism): number[] {
  return mechanism.calls.flatMap((c) => (c.method === "boundedSum" ? c.values : []));
}

/** How many distinct `boundedSum` calls included `value` among their inputs. */
export function partitionsContainingValue(mechanism: RecordingDpMechanism, value: number): number {
  return mechanism.calls.filter((c) => c.method === "boundedSum" && c.values.includes(value))
    .length;
}
