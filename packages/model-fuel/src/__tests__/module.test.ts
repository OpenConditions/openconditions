import { buildRegistry, kernelModule } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import {
  DATEX2_DELIVERY_UNITS,
  DATEX2_V2_FUEL_GRADES,
  DATEX2_V3_FUEL_GRADES,
} from "../crosswalk/datex2.js";
import { fuelModule } from "../module.js";
import { DATEX2_V2_FUEL, DATEX2_V3_FUEL } from "../vocabularies/datex2.js";

const registry = buildRegistry([kernelModule, fuelModule]);
type Table = Readonly<Record<string, string | null>>;
const unmapped = (values: readonly string[], table: Table, prefix = "") =>
  values.filter((v) => !(`${prefix}${v}` in table));

describe("fuel module", () => {
  it("builds on the kernel alone", () => {
    expect(registry.kind("feature", "fuel_station")?.domain).toBe("fuel");
    expect(registry.kinds("component").map((k) => k.code)).toContain("fuel_product");
  });

  it("prices a product per the unit it is sold in", () => {
    expect(registry.property("fuel.price")?.result).toEqual({
      type: "money",
      per: ["L", "kg", "m3"],
    });
  });

  it("keeps a month of prices raw and a daily rollup after that", () => {
    expect(registry.property("fuel.price")?.retention).toEqual({
      rawDays: 30,
      rollup: { period: "daily" },
    });
  });

  it("keeps every regulated cap, because a cap changes rarely", () => {
    expect(registry.property("fuel.price_cap")?.retention).toBeUndefined();
  });

  it("carries the grades a national price list publishes beyond the standards", () => {
    const grades = registry.vocabulary("fuel_grade")?.values ?? [];
    expect(grades).toEqual(
      expect.arrayContaining([
        "e25",
        "renewable_petrol",
        "agricultural_diesel",
        "methanol",
        "ammonia",
      ]),
    );
  });

  it("registers the district scheme US averages are published per", () => {
    expect(registry.vocabulary("admin_geocode_scheme")?.values).toContain("padd");
  });
});

describe("fuel crosswalk coverage", () => {
  it.each([
    ["petrol", DATEX2_V3_FUEL.petrolTypes, "petrol:"],
    ["diesel", DATEX2_V3_FUEL.dieselTypes, "diesel:"],
    ["bioethanol", DATEX2_V3_FUEL.bioethanolTypes, "bioethanol:"],
    ["organic gas", DATEX2_V3_FUEL.organicGasTypes, "organicGas:"],
    ["hydrogen", DATEX2_V3_FUEL.refillSolutionsHydrogen, "hydrogen:"],
  ] as const)("maps every DATEX II v3 %s grade", (_what, values, prefix) => {
    expect(unmapped(values, DATEX2_V3_FUEL_GRADES, prefix)).toEqual([]);
  });

  it("maps every DATEX II v2 fuel type", () => {
    expect(unmapped(DATEX2_V2_FUEL.fuelTypes, DATEX2_V2_FUEL_GRADES)).toEqual([]);
  });

  it("keeps only the delivery units a price can be compared in", () => {
    expect(unmapped(DATEX2_V3_FUEL.deliveryUnits, DATEX2_DELIVERY_UNITS)).toEqual([]);
    expect(DATEX2_DELIVERY_UNITS["kWh"]).toBeNull();
  });
});
