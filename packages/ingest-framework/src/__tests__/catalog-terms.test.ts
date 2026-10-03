import { describe, expect, it } from "vitest";
import { admitsCatalogChild, effectiveRights } from "../catalog/terms.js";

describe("effective rights", () => {
  it("an open licence admits catalogue children", () => {
    expect(admitsCatalogChild(effectiveRights("CC-BY-4.0"))).toBe(true);
  });

  it("terms override the licence field by field", () => {
    const r = effectiveRights("CC-BY-4.0", { url: "https://x", redistribution: false });
    expect(r.redistribution).toBe(false);
    expect(r.commercialUse).toBe(true);
    expect(admitsCatalogChild(r)).toBe(false);
  });

  it("an explicit null in terms overrides a known licence right", () => {
    expect(effectiveRights("CC-BY-4.0", { retention: null }).retention).toBeNull();
  });

  it("an explicit undefined in terms defers to the licence", () => {
    const r = effectiveRights("CC-BY-4.0", {
      redistribution: undefined,
      derivedRedistribution: undefined,
      commercialUse: undefined,
      attributionRequired: undefined,
      retention: undefined,
    });
    expect(r).toEqual(effectiveRights("CC-BY-4.0"));
  });

  it("NOASSERTION is unknown, not permissive", () => {
    expect(effectiveRights("NOASSERTION").redistribution).toBeNull();
    expect(admitsCatalogChild(effectiveRights("NOASSERTION"))).toBe(false);
  });

  it("terms can grant rights an unasserted licence lacks", () => {
    const r = effectiveRights("NOASSERTION", {
      redistribution: true,
      derivedRedistribution: true,
      commercialUse: true,
      retention: true,
    });
    expect(admitsCatalogChild(r)).toBe(true);
  });

  it("share-alike is a licence fact", () => {
    expect(effectiveRights("ODbL-1.0").shareAlike).toBe(true);
    expect(effectiveRights("CC-BY-4.0").shareAlike).toBe(false);
  });

  it("licence lookup is exact", () => {
    expect(() => effectiveRights("dl-de/by-2-0")).toThrow(/unknown licence/);
    expect(() => effectiveRights("cc-by-4.0")).toThrow(/unknown licence/);
  });
});
