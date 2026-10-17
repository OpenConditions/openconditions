import { describe, expect, it } from "vitest";
import { attributionLine, resolveAttribution, unknownAttributionPlaceholders } from "../index.js";

describe("attributionLine", () => {
  it("returns the attribution when the license requires it", () => {
    expect(attributionLine("CC-BY-4.0", "NDW / Rijkswaterstaat")).toBe("NDW / Rijkswaterstaat");
  });
  it("returns undefined when no attribution is required", () => {
    expect(attributionLine("DL-DE-ZERO-2.0", "Straßen.NRW")).toBeUndefined();
    expect(attributionLine("CC0-1.0", "anyone")).toBeUndefined();
  });
  it("still returns attribution when the license does not say or is unregistered (safe default)", () => {
    expect(attributionLine("NOASSERTION", "Some Provider")).toBe("Some Provider");
    expect(attributionLine("not-a-license", "Some Provider")).toBe("Some Provider");
  });
});

describe("resolveAttribution", () => {
  it("writes {year} as the UTC year of the instant", () => {
    const credit = "Contains modified Copernicus Sentinel data {year}, processed by EUMETSAT";
    expect(resolveAttribution(credit, new Date("2026-12-31T23:59:59Z"))).toBe(
      "Contains modified Copernicus Sentinel data 2026, processed by EUMETSAT",
    );
    expect(resolveAttribution(credit, new Date("2027-01-01T00:00:00+01:00"))).toBe(
      "Contains modified Copernicus Sentinel data 2026, processed by EUMETSAT",
    );
    expect(resolveAttribution("NDW", new Date())).toBe("NDW");
  });

  it("names every placeholder but {year}", () => {
    expect(unknownAttributionPlaceholders("Data {year} © {publisher}, {}")).toEqual([
      "{publisher}",
      "{}",
    ]);
    expect(unknownAttributionPlaceholders("Data {year}")).toEqual([]);
  });
});
