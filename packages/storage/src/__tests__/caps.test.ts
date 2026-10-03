import { describe, expect, it } from "vitest";
import {
  capRows,
  MAX_OBSERVATIONS_PER_POLL,
  MAX_ROWS_PER_SOURCE,
  maxObservationsPerPollFromEnv,
} from "../caps.js";

describe("capRows", () => {
  it("accepts a poll at or under the cap", () => {
    expect(() => capRows([1, 2, 3], "situation", 3)).not.toThrow();
  });

  it("refuses a poll over the cap, naming the class", () => {
    const rows = Array.from({ length: 5 }, (_, i) => i);
    expect(() => capRows(rows, "feature", 2)).toThrow(
      /5 feature rows, exceeding publication limit 2/,
    );
  });

  it("defaults to a large positive MAX_ROWS_PER_SOURCE", () => {
    expect(MAX_ROWS_PER_SOURCE).toBeGreaterThan(0);
    expect(() => capRows([1, 2, 3], "observation")).not.toThrow();
  });
});

describe("maxObservationsPerPollFromEnv", () => {
  it("caps readings at a million per poll by default, ten times a class of records", () => {
    expect(MAX_OBSERVATIONS_PER_POLL).toBe(1_000_000);
    expect(maxObservationsPerPollFromEnv({})).toBe(1_000_000);
  });

  it("takes OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL when it is a positive integer", () => {
    expect(
      maxObservationsPerPollFromEnv({ OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL: "2500000" }),
    ).toBe(2_500_000);
    for (const raw of ["", "0", "-3", "1.5", "lots"]) {
      expect(
        maxObservationsPerPollFromEnv({ OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL: raw }),
        raw,
      ).toBe(1_000_000);
    }
  });
});
