import { describe, expect, it } from "vitest";
import { vehicleClassesOf } from "../routing.js";

describe("vehicleClassesOf", () => {
  it("maps supported DATEX and WZDx vehicle terms to model vehicle classes", () => {
    expect(vehicleClassesOf(["passengerCar", "heavyGoodsVehicle", "publicTransport"])).toEqual([
      "car",
      "truck",
      "bus",
    ]);
  });

  it("names no classes for a negated, unknown or comparator-bearing term", () => {
    expect(vehicleClassesOf(["except buses"])).toBeNull();
    expect(vehicleClassesOf(["agriculturalVehicle"])).toBeNull();
    expect(vehicleClassesOf(["lorries above 7.5 t"])).toBeNull();
  });
});
