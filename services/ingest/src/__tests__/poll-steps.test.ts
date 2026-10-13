import { describe, expect, it } from "vitest";
import { PollSteps } from "../pipeline/poll-steps.js";

describe("PollSteps", () => {
  it("times each step from the end of the one before and adds up a step lapped twice", () => {
    let now = 1_000;
    const steps = new PollSteps(now, () => now);
    now += 1_200;
    steps.lap("fetch");
    now += 30;
    steps.lap("gate");
    now += 8_000;
    steps.lap("parse");
    now += 500;
    steps.lap("parse");
    expect(steps.ms).toEqual({ fetch: 1_200, gate: 30, parse: 8_500 });
  });

  it("describes the steps of 50 ms or more in order, the write's own stages beside it", () => {
    let now = 0;
    const steps = new PollSteps(now, () => now);
    now += 1_234;
    steps.lap("fetch");
    now += 49;
    steps.lap("gate");
    now += 48_100;
    steps.lap("write");
    steps.writeMs = { features: 3_000, readings: 40_200, canonical: 10 };
    expect(steps.describe()).toBe("fetch 1.2s, write 48.1s (features 3.0s, readings 40.2s)");
  });
});
