import { describe, expect, it } from "vitest";
import { LICENSES, licenseInfo } from "../index.js";

describe("license registry", () => {
  it("resolves a permissive no-attribution license", () => {
    const l = licenseInfo("dl-de/zero-2-0");
    expect(l).toMatchObject({ attributionRequired: false, shareAlike: false, commercialOk: true });
  });

  it("flags the one share-alike license the feed set carries", () => {
    const l = licenseInfo("CC-BY-SA-4.0");
    expect(l).toMatchObject({
      attributionRequired: true,
      shareAlike: true,
      commercialOk: true,
      spdxId: "CC-BY-SA-4.0",
    });
  });

  it("is case-insensitive and returns undefined for an unknown id", () => {
    expect(licenseInfo("cc0-1.0")?.id).toBe("CC0-1.0");
    expect(licenseInfo("not-a-license")).toBeUndefined();
  });

  it("exposes the registry table keyed by lowercased id", () => {
    expect(LICENSES["cc0-1.0"]?.id).toBe("CC0-1.0");
  });
});
