import { describe, expect, it } from "vitest";
import { normalizeVehicleApplicability } from "../routing.js";

describe("normalizeVehicleApplicability", () => {
  it("treats an absent selector as unrestricted", () => {
    expect(normalizeVehicleApplicability(undefined)).toEqual({ kind: "all" });
  });

  it("maps supported DATEX and WZDx vehicle terms to canonical classes", () => {
    expect(
      normalizeVehicleApplicability(["passengerCar", "heavyGoodsVehicle", "publicTransport"])
    ).toEqual({
      kind: "classes",
      classes: ["car", "truck", "bus"],
      raw: ["passengerCar", "heavyGoodsVehicle", "publicTransport"],
    });
  });

  it("keeps negated and unknown predicates fail-closed with the raw terms", () => {
    expect(normalizeVehicleApplicability(["except buses"])).toEqual({
      kind: "unknown",
      raw: ["except buses"],
    });
    expect(normalizeVehicleApplicability(["agriculturalVehicle"])).toEqual({
      kind: "unknown",
      raw: ["agriculturalVehicle"],
    });
  });

  it("does not widen a dimension-qualified vehicle scope to its broad class", () => {
    expect(
      normalizeVehicleApplicability(
        ["lorry"],
        [{ type: "height", value: 4.5, unit: "m", operator: "greaterThan" }]
      )
    ).toMatchObject({ kind: "unknown" });
  });
});
