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
    });
    expect(errors).toEqual([]);
  });

  it("rejects an approved catalogue child without affirmative reusable-source evidence", () => {
    const errors = lintFeed({
      id: "wzdx-unverified",
      name: "Unverified child",
      operator: "wzdx",
      format: "wzdx",
      url: "https://x.test/wzdx",
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "UNKNOWN",
      attribution: "Publisher",
      country: "US",
      privacyUrl: "https://x.test/privacy",
      parentSourceId: "us-wzdx",
      selectionState: "approved",
      policyIds: ["us-wzdx", "wzdx-unverified"],
    });
    expect(errors.join("\n")).toContain("approved catalogue child requires affirmative");
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
    });
    expect(errors.join("\n")).toContain("169.254.169.254");
  });
});
