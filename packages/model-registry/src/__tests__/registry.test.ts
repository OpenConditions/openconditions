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

  it("registers the roads, weather and vehicles domains", () => {
    const registry = productionRegistry();
    expect(productionModules.map((m) => m.name)).toEqual([
      "kernel",
      "roads",
      "weather",
      "vehicles",
    ]);
    expect(registry.domains().map((d) => d.code)).toEqual(["roads", "weather", "vehicles"]);
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
});
