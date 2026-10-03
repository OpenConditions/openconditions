import { productionRegistry } from "@openconditions/model-registry";
import { SPEED_BIN_WIDTH_KPH } from "@openconditions/storage";
import { describe, expect, it } from "vitest";

describe("speed histogram", () => {
  it("bins speeds at the width the registry declares for traffic.speed", () => {
    // Stored rollups hold bin indexes, so the width is part of their meaning:
    // the two can only change together, with a new traffic.speed major version.
    const rollup = productionRegistry().property("traffic.speed")?.retention?.rollup;
    expect(rollup).toEqual({ period: "hourly", histogram: { binWidth: SPEED_BIN_WIDTH_KPH } });
  });
});
