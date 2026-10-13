import { Licensing } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { LICENSES } from "./catalog/licenses.js";
import { captureLicensing } from "./licensing.js";

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
  it("retains exact notices and conditions and leaves unknown grants unresolved", () => {
    expect(
      captureLicensing({
        id: "example",
        license: "Unknown provider terms",
        terms: { notice: "© Author", note: "No navigation use" },
      }),
    ).toMatchObject({
      version: 1,
      bindings: [
        {
          license: { kind: "unknown", raw: "Unknown provider terms" },
          notice: "© Author",
          conditions: ["No navigation use"],
        },
      ],
    });
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
