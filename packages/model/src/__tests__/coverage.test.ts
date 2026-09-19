import { describe, expect, it } from "vitest";
import {
  assertRegistryCovers,
  RegistryCoverageError,
  uncoveredCodes,
} from "../registry/coverage.js";
import { registry } from "./fixtures.js";

describe("registry coverage", () => {
  it("accepts codes the registry registers", () => {
    expect(
      uncoveredCodes(registry, {
        sourceFormats: ["datex2", "crowd"],
        kinds: [{ class: "situation", code: "incident" }],
        properties: ["traffic.speed"],
      }),
    ).toEqual([]);
  });

  it("names every held code the registry does not register", () => {
    const held = {
      sourceFormats: ["datex2", "wzdx"],
      kinds: [{ class: "feature" as const, code: "charging_site" }],
      properties: ["fuel.price", "air.pm2_5"],
    };
    expect(uncoveredCodes(registry, held)).toEqual([
      'source_format "wzdx"',
      'feature kind "charging_site"',
      'property "air.pm2_5"',
    ]);
    expect(() => assertRegistryCovers(registry, held)).toThrow(RegistryCoverageError);
  });
});
