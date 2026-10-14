import { describe, expect, it } from "vitest";
import { resolveCrowdCredit } from "../crowd.js";

const credit = (env: Record<string, string>) => resolveCrowdCredit(env, "maps.example.org");

describe("resolveCrowdCredit", () => {
  it("names the instance and defaults to ODbL-1.0 without a link", () => {
    expect(credit({})).toEqual({
      name: "OpenConditions contributors at maps.example.org",
      license: "ODbL-1.0",
    });
    expect(
      credit({ OPENCONDITIONS_CROWD_LICENSE: "", OPENCONDITIONS_CROWD_SOURCE_URI: "" }),
    ).toEqual({ name: "OpenConditions contributors at maps.example.org", license: "ODbL-1.0" });
  });

  it("accepts a licence id the registry knows and an http(s) link", () => {
    expect(
      credit({
        OPENCONDITIONS_CROWD_LICENSE: "CC0-1.0",
        OPENCONDITIONS_CROWD_SOURCE_URI: "https://maps.example.org/reports",
      }),
    ).toEqual({
      name: "OpenConditions contributors at maps.example.org",
      license: "CC0-1.0",
      url: "https://maps.example.org/reports",
    });
  });

  it("fails fast on a licence id the registry does not know, case included", () => {
    for (const id of ["odbl-1.0", "CC-BY-SA-3.0", "Not-A-Licence"]) {
      expect(() => credit({ OPENCONDITIONS_CROWD_LICENSE: id })).toThrow(
        new RegExp(`OPENCONDITIONS_CROWD_LICENSE "${id}" is not a known licence id`),
      );
    }
  });

  it("fails fast on a link that is no http(s) URL", () => {
    for (const url of ["maps.example.org", "javascript:alert(1)", "ftp://maps.example.org/"]) {
      expect(() => credit({ OPENCONDITIONS_CROWD_SOURCE_URI: url })).toThrow(
        /OPENCONDITIONS_CROWD_SOURCE_URI .* is not an http\(s\) URL/,
      );
    }
  });
});
