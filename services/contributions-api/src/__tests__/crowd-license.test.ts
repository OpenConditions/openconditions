import { describe, expect, it } from "vitest";
import { resolveCrowdLicense } from "../crowd.js";

describe("resolveCrowdLicense", () => {
  it("defaults to ODbL-1.0", () => {
    expect(resolveCrowdLicense({})).toBe("ODbL-1.0");
    expect(resolveCrowdLicense({ OPENCONDITIONS_CROWD_LICENSE: "" })).toBe("ODbL-1.0");
  });

  it("accepts a licence id the registry knows", () => {
    expect(resolveCrowdLicense({ OPENCONDITIONS_CROWD_LICENSE: "CC0-1.0" })).toBe("CC0-1.0");
  });

  it("fails fast on an id the registry does not know, case included", () => {
    for (const id of ["odbl-1.0", "CC-BY-SA-3.0", "Not-A-Licence"]) {
      expect(() => resolveCrowdLicense({ OPENCONDITIONS_CROWD_LICENSE: id })).toThrow(
        new RegExp(`OPENCONDITIONS_CROWD_LICENSE "${id}" is not a known licence id`),
      );
    }
  });
});
