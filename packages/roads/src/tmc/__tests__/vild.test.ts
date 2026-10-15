import { describe, expect, it } from "vitest";
import { resolveVild } from "../vild.js";

const reference = (over = {}) => ({
  country: "8",
  table: "6.13",
  version: "A",
  primary: 22370,
  type: "AlertCMethod2Point",
  ...over,
});

describe("official VILD point references", () => {
  it("resolves the exact active edition with native identity and dataset provenance", () => {
    expect(resolveVild(reference())).toMatchObject({
      ok: true,
      geometry: { type: "Point", coordinates: [5.717227, 50.8408564] },
      locationTable: {
        ref: "VILD",
        version: "6.13.A",
        license: "CC0-1.0",
        attribution: expect.stringMatching(/Rijkswaterstaat/),
      },
    });
  });
  it.each([
    { country: "D" },
    { country: "NL" },
    { table: "1" },
    { table: "6.13junk" },
    { table: "6.130" },
  ])("never treats another namespace or malformed table as VILD: %j", (over) => {
    expect(resolveVild(reference(over))).toMatchObject({ ok: false, reason: "no-table" });
  });
  it.each(["B", "6.13.A", "A.bad"])("refuses edition substitution for %s", (version) => {
    expect(resolveVild(reference({ version }))).toEqual({ ok: false, reason: "version-mismatch" });
  });
  it("refuses missing versions, unknown codes and unsupported offset/linear methods", () => {
    expect(resolveVild(reference({ version: undefined }))).toEqual({
      ok: false,
      reason: "version-missing",
    });
    expect(resolveVild(reference({ primary: 999999 }))).toEqual({
      ok: false,
      reason: "unknown-code",
    });
    for (const over of [
      { type: "AlertCMethod4Point" },
      { type: "AlertCMethod2Linear", secondary: 16751 },
      { hasOffsets: true },
      { type: undefined },
    ]) {
      expect(resolveVild(reference(over))).toEqual({ ok: false, reason: "unsupported-reference" });
    }
  });
});
