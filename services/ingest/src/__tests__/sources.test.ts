import { describe, expect, it } from "vitest";
import { buildDomainRegistry } from "../domains.js";
import { catalogueSources } from "../sources.js";

describe("catalogueSources", () => {
  it("lists every scheduled feed once, with its domain and tier", async () => {
    const registry = await buildDomainRegistry();
    const sources = catalogueSources(registry);
    expect(sources.length).toBe(registry["roads"]!.feeds.length);
    expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
    const ndw = sources.find((s) => s.id === "nl-ndw")!;
    expect(ndw).toMatchObject({ domain: "roads", tier: "authoritative", format: "datex2" });
    expect(sources.every((s) => s.tier !== undefined)).toBe(true);
  });
});
