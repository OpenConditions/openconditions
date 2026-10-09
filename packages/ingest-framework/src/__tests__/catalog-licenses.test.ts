import { describe, expect, it } from "vitest";
import { LICENSES, licenseInfo } from "../catalog/licenses.js";

describe("licence registry", () => {
  it("holds the thirty-three licences in use", () => {
    expect(LICENSES).toHaveLength(33);
  });

  it("every licence id is an SPDX id, LicenseRef- or NOASSERTION", () => {
    for (const l of LICENSES) {
      expect(l.id).toMatch(/^(LicenseRef-[A-Za-z0-9.-]+|NOASSERTION|[A-Za-z0-9.+-]+)$/);
    }
  });

  it("ids are unique and every licence records a url", () => {
    expect(new Set(LICENSES.map((l) => l.id)).size).toBe(LICENSES.length);
    for (const l of LICENSES) expect(l.url).toMatch(/^https:\/\//);
  });

  it("lookup is exact and case-sensitive", () => {
    expect(licenseInfo("CC0-1.0")?.id).toBe("CC0-1.0");
    expect(licenseInfo("cc0-1.0")).toBeUndefined();
    expect(licenseInfo("dl-de/by-2-0")).toBeUndefined();
    expect(licenseInfo("DL-DE-BY-2.0")?.attributionRequired).toBe(true);
  });

  it("NOASSERTION asserts nothing", () => {
    expect(licenseInfo("NOASSERTION")).toMatchObject({
      redistribution: null,
      derivedRedistribution: null,
      commercialUse: null,
      attributionRequired: null,
      retention: null,
      shareAlike: false,
    });
  });

  it("flags share-alike licences", () => {
    expect(
      LICENSES.filter((l) => l.shareAlike)
        .map((l) => l.id)
        .sort(),
    ).toEqual(["CC-BY-SA-4.0", "ODbL-1.0"]);
  });
});
