import { describe, expect, it } from "vitest";
import { rawTierFor } from "../raw/tiers.js";

const rights = (retention: boolean | null) => ({
  sourceRedistribution: true,
  derivedRedistribution: true,
  commercialUse: true,
  attributionRequired: false,
  retention,
});

describe("rawTierFor", () => {
  it("keeps nothing of a source whose terms forbid retention", () => {
    expect(rawTierFor({ rights: rights(false) }, "feed")).toBeUndefined();
    expect(rawTierFor({ rights: rights(false) }, "reference")).toBeUndefined();
  });

  it("keeps only the last 48 hours of a source whose terms do not say", () => {
    expect(rawTierFor({}, "feed")).toBe("hot");
    expect(rawTierFor({ rights: rights(null) }, "reference")).toBe("hot");
  });

  it("keeps a source that affirms retention by what it produces", () => {
    expect(rawTierFor({ rights: rights(true) }, "feed")).toBe("situation");
    expect(rawTierFor({ rights: rights(true), produces: "flow" }, "feed")).toBe("observation");
    expect(rawTierFor({ rights: rights(true), produces: "flow" }, "reference")).toBe("reference");
    expect(rawTierFor({ rights: rights(true), rawRetention: "observation" }, "feed")).toBe(
      "observation",
    );
  });
});
