import { describe, it, expect } from "vitest";
import { normaliseSeverity, deriveSeverity } from "../severity.js";

describe("normaliseSeverity", () => {
  it('maps Open511 MAJOR to high with severitySource declared', () => {
    const result = normaliseSeverity("MAJOR", { format: "open511" });
    expect(result).toEqual({ severity: "high", severitySource: "declared" });
  });

  it('maps Open511 MINOR to low', () => {
    const result = normaliseSeverity("MINOR", { format: "open511" });
    expect(result).toEqual({ severity: "low", severitySource: "declared" });
  });

  it('maps Open511 MODERATE to medium', () => {
    const result = normaliseSeverity("MODERATE", { format: "open511" });
    expect(result).toEqual({ severity: "medium", severitySource: "declared" });
  });

  it('maps Open511 UNKNOWN to unknown', () => {
    const result = normaliseSeverity("UNKNOWN", { format: "open511" });
    expect(result).toEqual({ severity: "unknown", severitySource: "declared" });
  });

  it('maps DATEX II lowest to low', () => {
    const result = normaliseSeverity("lowest", { format: "datex2" });
    expect(result).toEqual({ severity: "low", severitySource: "declared" });
  });

  it('maps DATEX II medium to medium', () => {
    const result = normaliseSeverity("medium", { format: "datex2" });
    expect(result).toEqual({ severity: "medium", severitySource: "declared" });
  });

  it('maps DATEX II high to high', () => {
    const result = normaliseSeverity("high", { format: "datex2" });
    expect(result).toEqual({ severity: "high", severitySource: "declared" });
  });

  it('maps DATEX II highest to critical', () => {
    const result = normaliseSeverity("highest", { format: "datex2" });
    expect(result).toEqual({ severity: "critical", severitySource: "declared" });
  });

  it('returns unknown for unrecognised values', () => {
    const result = normaliseSeverity("BOGUS", { format: "open511" });
    expect(result).toEqual({ severity: "unknown", severitySource: "declared" });
  });
});

describe("deriveSeverity", () => {
  it('returns high when roadState is closed', () => {
    expect(deriveSeverity({ roadState: "closed" })).toBe("high");
  });

  it('returns medium when some lanes are closed (1 of 3)', () => {
    expect(deriveSeverity({ lanesAffected: { closed: 1, total: 3 } })).toBe("medium");
  });

  it('returns high when all lanes are closed', () => {
    expect(deriveSeverity({ lanesAffected: { closed: 2, total: 2 } })).toBe("high");
  });

  it('returns low when minor lane impact (1 of 4)', () => {
    expect(deriveSeverity({ lanesAffected: { closed: 1, total: 4 } })).toBe("low");
  });

  it('returns unknown when no signal provided', () => {
    expect(deriveSeverity({})).toBe("unknown");
  });
});
