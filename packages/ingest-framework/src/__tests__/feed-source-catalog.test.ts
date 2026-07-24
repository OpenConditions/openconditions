import { describe, expect, it } from "vitest";
import type { FeedSourceBase } from "../index.js";

describe("FeedSourceBase.catalog", () => {
  it("accepts a declarative catalog reference with an optional filter", () => {
    const feed: FeedSourceBase = {
      id: "wzdx",
      name: "WZDx (United States)",
      operator: "test",
      format: "wzdx",
      catalog: { resolver: "wzdx-registry", filter: { country: "US" } },
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "CC0-1.0",
      attribution: "WZDx publishers",
      country: "US",
      privacyUrl: "https://www.transportation.gov/privacy",
    };
    expect(feed.catalog?.resolver).toBe("wzdx-registry");
    expect(feed.catalog?.filter?.["country"]).toBe("US");
  });
});
