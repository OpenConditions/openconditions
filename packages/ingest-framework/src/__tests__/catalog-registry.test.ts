import { afterEach, describe, expect, it } from "vitest";
import type { CatalogResolver, FeedSourceBase } from "../index.js";
import {
  __resetCatalogResolvers,
  getCatalogResolver,
  getCatalogResolverById,
  registerCatalogResolver,
} from "../catalog.js";

const stub: CatalogResolver = {
  id: "wzdx-registry",
  snapshotPath: "/nonexistent/snapshot.json",
  resolve: async () => [] as FeedSourceBase[],
};

afterEach(() => __resetCatalogResolvers());

describe("catalog resolver registry", () => {
  it("registers and retrieves a resolver by (domain, id)", () => {
    registerCatalogResolver("roads", stub);
    expect(getCatalogResolver("roads", "wzdx-registry")).toBe(stub);
    expect(getCatalogResolverById("wzdx-registry")).toBe(stub);
  });

  it("throws for an unknown resolver id", () => {
    expect(() => getCatalogResolver("roads", "nope")).toThrow(/nope/);
    expect(() => getCatalogResolverById("nope")).toThrow(/nope/);
  });

  it("throws when the same resolver id is registered twice", () => {
    registerCatalogResolver("roads", stub);
    expect(() => registerCatalogResolver("transit", stub)).toThrow(/wzdx-registry/);
  });
});
