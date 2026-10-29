import { Licensing } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { LICENSES } from "./catalog/licenses.js";
import { captureLicensing } from "./licensing.js";
import { reviewedAttributionPolicy } from "./reviewed-attribution-policies.js";

describe("captured licence bindings", () => {
  it("captures every curated licence without changing semantic policy IDs", () => {
    for (const info of LICENSES) {
      const captured = captureLicensing({ id: "example", license: info.id });
      expect(Licensing.safeParse(captured).success).toBe(true);
      const grant = captured.bindings[0].license;
      if (info.id.startsWith("LicenseRef-"))
        expect(grant).toMatchObject({ kind: "custom", name: info.name, id: info.id });
      else if (info.id !== "NOASSERTION")
        expect(grant).toMatchObject({ kind: "spdx", expression: info.id });
    }
  });
  it("retains the exact notice and leaves unknown grants unresolved", () => {
    expect(
      captureLicensing({
        id: "example",
        license: "Unknown provider terms",
        terms: { notice: "© Author" },
      }),
    ).toMatchObject({
      version: 1,
      bindings: [
        {
          license: { kind: "unknown", raw: "Unknown provider terms" },
          notice: "© Author",
        },
      ],
    });
  });
  it("keeps the reviewer's note out of the credit", () => {
    const feed = {
      id: "example",
      license: "CC-BY-4.0",
      terms: { note: "Licence review: offer 123 states CC BY 4.0", notice: "© Author" },
    };
    const [binding] = captureLicensing(feed).bindings;
    expect(binding.conditions).toBeUndefined();
    expect(JSON.stringify(binding)).not.toContain("offer 123");
  });
});

it("rejects credential-bearing attribution URLs at the portable boundary", () => {
  for (const url of [
    "https://user:password@example.test/terms",
    "https://example.test/terms?api_key=private",
    "https://example.test/terms?X-Amz-Signature=private",
  ]) {
    expect(
      Licensing.safeParse({
        version: 1,
        bindings: [{ scope: "data", subject: "Dataset", license: { kind: "unknown", url } }],
      }).success,
    ).toBe(false);
  }
  expect(
    Licensing.safeParse({
      version: 1,
      bindings: [
        {
          scope: "data",
          subject: "Dataset",
          license: { kind: "unknown", url: "https://example.test/terms?lang=en" },
        },
      ],
    }).success,
  ).toBe(true);
});

it("captures a feed's reviewed placement without changing its policy licence", () => {
  const attributionPolicy = {
    placement: "visible",
    surfaces: ["map", "image"],
    basis: "provider-terms",
    reviewedAt: "2026-10-14",
    evidenceUrls: ["https://example.test/terms"],
    reason: "Retain linked provider credit",
    compactText: '<a href="https://example.test/">Provider</a>',
  } as const;
  const captured = captureLicensing({ id: "example", license: "CC-BY-4.0", attributionPolicy });
  expect(captured.bindings[0].attribution).toEqual(attributionPolicy);
  expect(captured.bindings[0].attribution).not.toBe(attributionPolicy);
  expect(captured.bindings[0].license).toMatchObject({ kind: "spdx", expression: "CC-BY-4.0" });
});

it("does not treat prototype names as reviewed custom licences", () => {
  for (const id of ["__proto__", "constructor", "toString"])
    expect(reviewedAttributionPolicy(id)).toBeUndefined();
});
