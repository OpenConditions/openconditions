import { describe, expect, it } from "vitest";
import { DOMAIN_REGISTRY, buildDomainRegistry } from "../domains.js";

describe("DOMAIN_REGISTRY", () => {
  it("registers roads as an IngestDomain with name + parser dispatch", () => {
    const roads = DOMAIN_REGISTRY["roads"];
    expect(roads?.name).toBe("roads");
    expect(typeof roads?.parserFor).toBe("function");
    expect(typeof roads?.flowParserFor).toBe("function");
  });

  it("is dispatch-only: the static registry carries no feeds (they load at boot)", () => {
    expect(DOMAIN_REGISTRY["roads"]?.feeds).toEqual([]);
  });
});

describe("buildDomainRegistry", () => {
  it("populates roads with the baked-in feed set", async () => {
    const registry = await buildDomainRegistry();
    expect(registry["roads"]?.feeds.length).toBeGreaterThan(0);
    expect(typeof registry["roads"]?.parserFor).toBe("function");
  });
});
