import { describe, expect, it, test } from "vitest";
import { LICENSES } from "../catalog/licenses.js";
import {
  type EgressRecord,
  isPublicLicense,
  isPublicRecord,
  publicLicenseClassification,
  publicRecords,
  withoutReporter,
} from "../public-license.js";

describe("publicLicenseClassification", () => {
  const entries = [
    { id: "CC-BY-4.0", name: "CC BY", url: "https://a", redistribution: true, shareAlike: false },
    { id: "ODbL-1.0", name: "ODbL", url: "https://b", redistribution: true, shareAlike: true },
  ];

  it("hashes what isPublicLicense reads, whatever the order", () => {
    const hash = publicLicenseClassification(entries);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(publicLicenseClassification([...entries].reverse())).toBe(hash);
    expect(publicLicenseClassification(entries.map((e) => ({ ...e, name: "renamed" })))).toBe(hash);
  });

  it("changes when a licence's public classification inputs change", () => {
    const hash = publicLicenseClassification(entries);
    const flip = (i: number, over: object) =>
      publicLicenseClassification(entries.map((e, j) => (i === j ? { ...e, ...over } : e)));
    expect(flip(0, { redistribution: null })).not.toBe(hash);
    expect(flip(1, { shareAlike: false })).not.toBe(hash);
    expect(publicLicenseClassification([...entries, { ...entries[0]!, id: "CC0-1.0" }])).not.toBe(
      hash,
    );
  });

  it("defaults to the registry", () => {
    expect(publicLicenseClassification()).toBe(publicLicenseClassification(LICENSES));
  });
});

test("isPublicLicense needs affirmative redistribution and no share-alike", () => {
  expect(isPublicLicense("CC-BY-4.0")).toBe(true);
  expect(isPublicLicense("NOASSERTION")).toBe(false);
  expect(isPublicLicense("ODbL-1.0")).toBe(false);
  expect(isPublicLicense(undefined)).toBe(false);
});

describe("licence egress of model records", () => {
  const SECRET_KEY = "SECRET_REPORTER_KEY_ABC123";
  const record = (provenance: Partial<EgressRecord["provenance"]> = {}): EgressRecord => ({
    provenance: { attribution: { license: "CC0-1.0" }, ...provenance },
  });

  it("judges a record by its own licence and every upstream publisher's", () => {
    expect(isPublicRecord(record())).toBe(true);
    expect(isPublicRecord(record({ attribution: { license: "CC-BY-SA-4.0" } }))).toBe(false);
    expect(isPublicRecord(record({ upstream: [{ license: "ODbL-1.0" }] }))).toBe(false);
    expect(isPublicRecord(record({ upstream: [{ license: "NOASSERTION" }] }))).toBe(false);
    expect(isPublicRecord(record({ upstream: [{ license: "CC-BY-4.0" }] }))).toBe(true);
  });

  it("covers an upstream publisher that states no licence by the record's own", () => {
    expect(isPublicRecord(record({ upstream: [{}] }))).toBe(true);
    expect(
      isPublicRecord(record({ attribution: { license: "NOASSERTION" }, upstream: [{}] })),
    ).toBe(false);
  });

  it("strips the reporter, and merged sources whose licence is not public", () => {
    expect(withoutReporter(record({ reporter: { keyId: SECRET_KEY } })).provenance).toEqual({
      attribution: { license: "CC0-1.0" },
    });
    const [merged] = publicRecords([
      record({
        reporter: { keyId: SECRET_KEY },
        mergedSources: [
          { attribution: { license: "CC-BY-SA-4.0" } },
          { attribution: { license: "NOASSERTION" } },
          { attribution: { license: "CC-BY-4.0" } },
        ],
      }),
    ]);
    expect(merged!.provenance.mergedSources).toEqual([{ attribution: { license: "CC-BY-4.0" } }]);
    expect(JSON.stringify(merged)).not.toContain(SECRET_KEY);
    const [alone] = publicRecords([
      record({ mergedSources: [{ attribution: { license: "CC-BY-SA-4.0" } }] }),
    ]);
    expect(alone!.provenance).not.toHaveProperty("mergedSources");
  });
});

describe("registry-driven public licences", () => {
  it("fails closed on a licence id the registry does not know", () => {
    for (const unknown of ["odbl-1.0", "CC-BY-SA-3.0", "cc0-1.0", "Not-A-Licence"]) {
      expect(isPublicLicense(unknown)).toBe(false);
      expect(isPublicRecord({ provenance: { attribution: { license: unknown } } })).toBe(false);
      expect(
        isPublicRecord({
          provenance: { attribution: { license: "CC0-1.0" }, upstream: [{ license: unknown }] },
        }),
      ).toBe(false);
    }
    expect(isPublicLicense("CC0-1.0")).toBe(true);
    expect(isPublicLicense(null)).toBe(false);
    expect(isPublicLicense("")).toBe(false);
  });

  it("drops share-alike and unasserted records from a public export", () => {
    const kept = publicRecords([
      { provenance: { attribution: { license: "CC-BY-SA-4.0" } } },
      { provenance: { attribution: { license: "NOASSERTION" } } },
      { provenance: { attribution: { license: "DL-DE-ZERO-2.0" } } },
    ]);
    expect(kept.map((r) => r.provenance.attribution.license)).toEqual(["DL-DE-ZERO-2.0"]);
  });
});
