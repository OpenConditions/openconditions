import { describe, expect, it } from "vitest";
import { catalogueSources } from "../sources.js";
import { REPO_CATALOG } from "./helpers/catalog.js";

describe("catalogueSources", () => {
  it("lists every scheduled feed once, with its domain, product and tier", () => {
    const sources = catalogueSources(REPO_CATALOG);
    expect(sources.length).toBe(REPO_CATALOG.feeds.length);
    expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
    expect(sources.find((s) => s.id === "nl-ndw-events")).toMatchObject({
      domain: "roads",
      product: "events",
      tier: "authoritative",
      format: "datex2",
      country: "NL",
    });
    expect(sources.find((s) => s.id === "nl-ndw-flow")).toMatchObject({ product: "flow" });
    expect(sources.every((s) => s.tier !== undefined && s.rights !== undefined)).toBe(true);
  });
});
