import { describe, expect, it } from "vitest";
import { lintFeed } from "../../scripts/feeds-lint.js";

describe("feeds-lint license rule", () => {
  it("rejects a feed whose license is not registered", () => {
    const errors = lintFeed({
      id: "x",
      name: "X",
      operator: "x",
      format: "geojson",
      url: "https://x.test/a.json",
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "MADE-UP-1.0",
      attribution: "t",
      country: "NL",
      privacyUrl: "https://x",
      enabledByDefault: true,
    });
    expect(errors.join("\n")).toContain("unknown license id 'MADE-UP-1.0'");
  });

  it("accepts a feed whose license is registered", () => {
    const errors = lintFeed({
      id: "x",
      name: "X",
      operator: "x",
      format: "geojson",
      url: "https://x.test/a.json",
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "CC0-1.0",
      attribution: "t",
      country: "NL",
      privacyUrl: "https://x",
      enabledByDefault: true,
    });
    expect(errors).toEqual([]);
  });

  it("catches a private-IP siteTable.url", () => {
    const errors = lintFeed({
      id: "x",
      name: "X",
      operator: "x",
      format: "datex2",
      url: "https://x.test/a.xml",
      siteTable: { url: "http://169.254.169.254/latest/meta-data" },
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "CC0-1.0",
      attribution: "t",
      country: "NL",
      privacyUrl: "https://x",
      enabledByDefault: true,
    });
    expect(errors.join("\n")).toContain("169.254.169.254");
  });

  it("catches a private-IP stationRegistry.url", () => {
    const errors = lintFeed({
      id: "x",
      name: "X",
      operator: "x",
      format: "datex2",
      url: "https://x.test/a.xml",
      stationRegistry: { url: "http://169.254.169.254/latest/meta-data", format: "webtris-sites" },
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "CC0-1.0",
      attribution: "t",
      country: "NL",
      privacyUrl: "https://x",
      enabledByDefault: true,
    });
    expect(errors.join("\n")).toContain("169.254.169.254");
  });
});
