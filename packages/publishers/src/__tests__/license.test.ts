import { describe, expect, it } from "vitest";
import { filterForPermissiveExport, isShareAlikeLicense } from "../license.js";
import { roadEvent } from "./fixture.js";

describe("isShareAlikeLicense", () => {
  it("flags share-alike / copyleft licenses", () => {
    expect(isShareAlikeLicense("CC-BY-SA-4.0")).toBe(true);
    expect(isShareAlikeLicense("ODbL-1.0")).toBe(true);
    expect(isShareAlikeLicense("GPL-3.0")).toBe(true);
  });
  it("does not flag permissive / public-domain licenses or absence", () => {
    expect(isShareAlikeLicense("CC0-1.0")).toBe(false);
    expect(isShareAlikeLicense("CC-BY-4.0")).toBe(false);
    expect(isShareAlikeLicense(undefined)).toBe(false);
  });
});

describe("filterForPermissiveExport", () => {
  it("drops share-alike records, keeps permissive + unlicensed", () => {
    const mk = (id: string, license: string) =>
      roadEvent({ id, origin: { kind: "feed", attribution: { provider: "p", license } } });
    const out = filterForPermissiveExport([
      mk("keep-cc0", "CC0-1.0"),
      mk("drop-sa", "CC-BY-SA-4.0"),
      mk("drop-odbl", "ODbL-1.0"),
      mk("keep-by", "CC-BY-4.0"),
    ]);
    expect(out.map((o) => o.id)).toEqual(["keep-cc0", "keep-by"]);
  });
});
