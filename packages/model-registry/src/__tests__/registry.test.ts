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
});
