import { describe, expect, it } from "vitest";
import type { IngestDomain, FeedSourceBase } from "../index.js";

describe("IngestDomain", () => {
  it("accepts a minimal domain plugin shape", () => {
    const feed: FeedSourceBase = {
      id: "x",
      name: "X",
      operator: "test",
      format: "geojson",
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "CC0-1.0",
      attribution: "t",
      country: "NL",
      privacyUrl: "https://x",
    };
    const domain: IngestDomain = {
      name: "roads",
      feeds: [feed],
      parserFor: () => () => [],
      attributes: () => ({}),
    };
    expect(domain.feeds[0]?.id).toBe("x");
    expect(domain.parserFor("geojson")(Buffer.from(""))).toEqual([]);
  });
});
