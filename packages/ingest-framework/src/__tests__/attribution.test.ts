import { describe, expect, it } from "vitest";
import { attributionLine } from "../index.js";

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
