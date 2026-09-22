import { KERNEL_VERSION, kernelModule } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { productionModules, productionRegistry } from "../index.js";

describe("production registry", () => {
  it("assembles the kernel module first", () => {
    expect(productionModules[0]).toBe(kernelModule);
  });

  it("builds once and closes the kernel vocabularies", () => {
    const registry = productionRegistry();
    expect(productionRegistry()).toBe(registry);
    expect(registry.kernelVersion).toBe(KERNEL_VERSION);
    expect(registry.vocabulary("source_tier")).toBeDefined();
  });

  it("registers every domain OpenConditions models", () => {
    const registry = productionRegistry();
    expect(productionModules.map((m) => m.name)).toEqual([
      "kernel",
      "roads",
      "weather",
      "vehicles",
      "parking",
      "charging",
      "fuel",
    ]);
    expect(registry.domains().map((d) => d.code)).toEqual([
      "roads",
      "weather",
      "vehicles",
      "parking",
      "charging",
      "fuel",
    ]);
    expect(registry.kind("situation", "roadworks")?.domain).toBe("roads");
    expect(registry.vocabulary("source_format")!.values).toContain("datex2");
  });

  it("gives each infrastructure property the domain of what it measures", () => {
    const registry = productionRegistry();
    expect(registry.property("traffic.speed")?.domain).toBe("roads");
    expect(registry.property("road.surface_state")?.domain).toBe("weather");
    expect(registry.property("vehicle.position")?.domain).toBe("vehicles");
    expect(registry.kind("feature", "weather_station")?.traits).toContain("field_device");
  });

  it("registers the first offers and the kinds they price", () => {
    const registry = productionRegistry();
    expect(registry.kinds("offer").map((k) => k.code)).toEqual(["parking_rate", "energy_tariff"]);
    expect(registry.kind("feature", "parking_site")?.components).toEqual([
      "parking_area",
      "parking_space",
    ]);
    expect(registry.kind("feature", "fuel_station")?.components).toEqual(["fuel_product"]);
  });

  it("gives every facility kind rules for recognising it across sources", () => {
    const registry = productionRegistry();
    for (const kind of ["parking_site", "charging_site", "fuel_station"]) {
      const linking = registry.kind("feature", kind)?.linking;
      expect(linking?.osm?.tags.length).toBeGreaterThan(0);
      expect(linking!.alwaysMetres).toBeLessThanOrEqual(linking!.neverMetres);
    }
  });
});
