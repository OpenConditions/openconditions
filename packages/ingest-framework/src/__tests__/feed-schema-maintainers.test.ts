import { describe, expect, it } from "vitest";
import { feedSourceBaseSchema } from "../feed-schema.js";

// A minimal valid feed; the maintainers field is what this test varies.
const base = {
  id: "x",
  name: "X",
  operator: "x",
  format: "geojson",
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "t",
  country: "NL",
  privacyUrl: "https://example.test/privacy",
  enabledByDefault: true,
};

describe("feedSourceBaseSchema — maintainers", () => {
  it("accepts a feed with well-formed maintainers", () => {
    const parsed = feedSourceBaseSchema.parse({
      ...base,
      maintainers: [{ name: "Ada Lovelace", github: "ada" }],
    });
    expect(parsed.maintainers?.[0]?.github).toBe("ada");
  });

  it("accepts a feed with no maintainers (optional)", () => {
    expect(() => feedSourceBaseSchema.parse(base)).not.toThrow();
  });

  it("rejects a maintainer missing github", () => {
    expect(() =>
      feedSourceBaseSchema.parse({ ...base, maintainers: [{ name: "no handle" }] })
    ).toThrow();
  });

  it("rejects an empty github handle", () => {
    expect(() =>
      feedSourceBaseSchema.parse({ ...base, maintainers: [{ name: "x", github: "" }] })
    ).toThrow();
  });
});
