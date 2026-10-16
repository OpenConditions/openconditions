import { expect, it } from "vitest";
import { creditLicensingOf, Licensing } from "../kernel/licensing.js";

it("preserves captured grants and augments the existing raw declaration with its original terms link", () => {
  const original = {
    version: 1 as const,
    bindings: [
      {
        scope: "data" as const,
        subject: "Original",
        license: { kind: "spdx" as const, expression: "CC-BY-4.0" },
        notice: "Original exact notice",
        conditions: ["Original condition"],
      },
    ],
    declarations: [
      { text: "CC-BY-4.0" },
      { text: "Other declaration", url: "https://other.test/terms" },
    ],
  };
  const credit = creditLicensingOf({
    licensing: original,
    license: "CC-BY-4.0",
    licenseUrl: "https://terms.test/original",
  });
  expect(credit).toEqual({
    ...original,
    declarations: [
      { text: "CC-BY-4.0", url: "https://terms.test/original" },
      original.declarations[1],
    ],
  });
  expect(original.declarations[0]).toEqual({ text: "CC-BY-4.0" });
});
it("deduplicates an existing binding link and never turns a valid 64 declarations into 65", () => {
  const declarations = Array.from({ length: 64 }, (_, i) => ({ text: `Declaration ${i}` }));
  const licensing = {
    version: 1 as const,
    bindings: [
      {
        scope: "data" as const,
        subject: "Original",
        license: {
          kind: "spdx" as const,
          expression: "CC-BY-4.0",
          url: "https://terms.test/original",
        },
      },
    ],
    declarations,
  };
  expect(
    creditLicensingOf({
      licensing,
      license: "CC-BY-4.0",
      licenseUrl: "https://terms.test/original",
    }),
  ).toBe(licensing);
  const augmented = creditLicensingOf({
    licensing: {
      ...licensing,
      bindings: [],
      declarations: [{ text: "CC-BY-4.0" }, ...declarations.slice(1)],
    },
    license: "CC-BY-4.0",
    licenseUrl: "https://terms.test/original",
  });
  expect(augmented!.declarations).toHaveLength(64);
  expect(Licensing.safeParse(augmented).success).toBe(true);
  expect(() =>
    creditLicensingOf({
      licensing: { ...licensing, bindings: [] },
      license: "CC-BY-4.0",
      licenseUrl: "https://terms.test/new",
    }),
  ).toThrow(RangeError);
});
it("captures a terms URL without captured grants as evidence only", () => {
  expect(
    creditLicensingOf({
      license: "LicenseRef-Original",
      licenseUrl: "https://terms.test/original",
    }),
  ).toEqual({
    version: 1,
    bindings: [],
    declarations: [{ text: "LicenseRef-Original", url: "https://terms.test/original" }],
  });
});
