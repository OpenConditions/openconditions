import { describe, expect, it } from "vitest";
import { feature, m, observation, ok, registry } from "./network-drafts.js";

describe("travel times", () => {
  const route = feature("travel_time_route", "100357", {
    length: m(2400),
    freeFlowTravelTime: { value: 120, unit: "s" },
    fromName: [{ lang: "nb", text: "Sandvika" }],
    toName: [{ lang: "nb", text: "Lysaker" }],
  });

  it("observes a journey time in seconds on its route", () => {
    expect(ok(route)).toBe(true);
    expect(
      ok(observation(route, "traffic.travel_time", { type: "quantity", value: 142, unit: "s" })),
    ).toBe(true);
    expect(
      registry.validateDraft(
        observation(route, "traffic.travel_time", { type: "quantity", value: 2.4, unit: "min" }),
      ).ok,
    ).toBe(false);
  });

  it("observes the level of service a publisher states per route", () => {
    expect(
      ok(
        observation(route, "traffic.los", {
          type: "category",
          value: "free_flow",
          vocabulary: "los",
        }),
      ),
    ).toBe(true);
  });

  it("reads DATEX travel times and their trend", () => {
    const cw = registry.crosswalk;
    expect(cw.property("datex2_v3", "TravelTimeData/travelTime")).toBe("traffic.travel_time");
    expect(cw.property("datex2_v3", "TravelTimeData/freeFlowTravelTime")).toBeUndefined();
    expect(cw.value("trend", "datex2_v3", "travelTimeTrendType:increasing")).toBe("rising");
    expect(cw.value("trend", "datex2_v2", "travelTimeTrendType:_extended")).toBeUndefined();
    expect(cw.valueTargetCode("trend", "datex2_v3", "falling", "travelTimeTrendType")).toBe(
      "travelTimeTrendType:decreasing",
    );
  });
});
