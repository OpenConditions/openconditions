import { describe, expect, it } from "vitest";
import { highwayPrior, scoreCandidate } from "../score.js";

describe("scoreCandidate", () => {
  it("perfect candidate scores 1", () => {
    expect(
      scoreCandidate({ offsetM: 0, bearingDelta: 0, refScore: 1, highway: "motorway" }, 40)
    ).toBeCloseTo(1, 5);
  });
  it("bearing beyond 90 degrees is disqualifying (score 0)", () => {
    expect(
      scoreCandidate({ offsetM: 0, bearingDelta: 120, refScore: 1, highway: "motorway" }, 40)
    ).toBe(0);
  });
  it("without a bearing, the bearing weight moves to offset", () => {
    const a = scoreCandidate(
      { offsetM: 20, bearingDelta: null, refScore: 1, highway: "motorway" },
      40
    );
    // 0.7*offset(0.5) + 0.2*1 + 0.1*1 = 0.65
    expect(a).toBeCloseTo(0.65, 5);
  });
  it("motorway beats its link road at equal geometry", () => {
    expect(highwayPrior("motorway")).toBeGreaterThan(highwayPrior("motorway_link"));
    expect(highwayPrior("unknown_class")).toBe(0.8);
  });
});
