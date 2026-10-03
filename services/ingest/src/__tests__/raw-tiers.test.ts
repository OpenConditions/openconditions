import { describe, expect, it } from "vitest";
import { rawTierFor } from "../raw/tiers.js";
import { testFeed } from "./helpers/catalog.js";

const rights = (retention: boolean | null) => ({
  redistribution: true,
  derivedRedistribution: true,
  commercialUse: true,
  attributionRequired: false,
  retention,
  shareAlike: false,
});

const events = (retention: boolean | null, over = {}) =>
  testFeed({ rights: rights(retention), ...over });
const flow = (retention: boolean | null) =>
  testFeed({ rights: rights(retention), product: "flow", format: "datex2-measured" });

describe("rawTierFor", () => {
  it("keeps nothing of a source whose terms forbid retention", () => {
    expect(rawTierFor(events(false), "feed")).toBeUndefined();
    expect(rawTierFor(events(false), "reference")).toBeUndefined();
  });

  it("keeps only the last 48 hours of a source whose terms do not say", () => {
    expect(rawTierFor(events(null), "feed")).toBe("hot");
    expect(rawTierFor(events(null), "reference")).toBe("hot");
  });

  it("keeps a source that affirms retention by its format's kind", () => {
    expect(rawTierFor(events(true), "feed")).toBe("situation");
    expect(rawTierFor(flow(true), "feed")).toBe("observation");
    expect(rawTierFor(flow(true), "reference")).toBe("reference");
    expect(rawTierFor(events(true, { rawRetention: "observation" }), "feed")).toBe("observation");
  });
});
