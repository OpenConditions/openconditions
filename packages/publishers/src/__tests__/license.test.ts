import { describe, expect, it } from "vitest";
import {
  type EgressRecord,
  isPermissiveLicense,
  isPermissiveRecord,
  isShareAlikeLicense,
  permissiveRecords,
  withoutReporter,
} from "../license.js";

describe("licence egress of model records", () => {
  const SECRET_KEY = "SECRET_REPORTER_KEY_ABC123";
  const record = (provenance: Partial<EgressRecord["provenance"]> = {}): EgressRecord => ({
    provenance: { attribution: { license: "CC0-1.0" }, ...provenance },
  });

  it("judges a record by its own licence and every upstream publisher's", () => {
    expect(isPermissiveRecord(record())).toBe(true);
    expect(isPermissiveRecord(record({ attribution: { license: "CC-BY-SA-4.0" } }))).toBe(false);
    expect(isPermissiveRecord(record({ upstream: [{ license: "ODbL-1.0" }] }))).toBe(false);
    expect(isPermissiveRecord(record({ upstream: [{}] }))).toBe(true);
  });

  it("strips the reporter, and share-alike merged sources", () => {
    expect(withoutReporter(record({ reporter: { keyId: SECRET_KEY } })).provenance).toEqual({
      attribution: { license: "CC0-1.0" },
    });
    const [merged] = permissiveRecords([
      record({
        reporter: { keyId: SECRET_KEY },
        mergedSources: [
          { attribution: { license: "CC-BY-SA-4.0" } },
          { attribution: { license: "CC-BY-4.0" } },
        ],
      }),
    ]);
    expect(merged!.provenance.mergedSources).toEqual([{ attribution: { license: "CC-BY-4.0" } }]);
    expect(JSON.stringify(merged)).not.toContain(SECRET_KEY);
    const [alone] = permissiveRecords([
      record({ mergedSources: [{ attribution: { license: "CC-BY-SA-4.0" } }] }),
    ]);
    expect(alone!.provenance).not.toHaveProperty("mergedSources");
  });
});

describe("registry-driven share-alike", () => {
  it("uses the registry flag, not substrings", () => {
    expect(isShareAlikeLicense("CC-BY-SA-4.0")).toBe(true); // registry: shareAlike:true
    expect(isShareAlikeLicense("DL-DE-ZERO-2.0")).toBe(false); // registry: shareAlike:false
  });

  it("does not guess for a license not in the registry", () => {
    expect(isShareAlikeLicense("odbl")).toBe(false);
  });

  it("fails closed on a licence id the registry does not know", () => {
    for (const unknown of ["odbl-1.0", "CC-BY-SA-3.0", "cc0-1.0", "Not-A-Licence"]) {
      expect(isPermissiveLicense(unknown)).toBe(false);
      expect(isPermissiveRecord({ provenance: { attribution: { license: unknown } } })).toBe(false);
      expect(
        isPermissiveRecord({
          provenance: { attribution: { license: "CC0-1.0" }, upstream: [{ license: unknown }] },
        }),
      ).toBe(false);
    }
    expect(isPermissiveLicense("CC0-1.0")).toBe(true);
    expect(isPermissiveLicense(undefined)).toBe(true);
  });

  it("drops share-alike records from a permissive export using the registry flag", () => {
    const kept = permissiveRecords([
      { provenance: { attribution: { license: "CC-BY-SA-4.0" } } },
      { provenance: { attribution: { license: "DL-DE-ZERO-2.0" } } },
    ]);
    expect(kept.map((r) => r.provenance.attribution.license)).toEqual(["DL-DE-ZERO-2.0"]);
  });
});

describe("isShareAlikeLicense", () => {
  it("flags share-alike licenses", () => {
    expect(isShareAlikeLicense("CC-BY-SA-4.0")).toBe(true);
    expect(isShareAlikeLicense("ODbL-1.0")).toBe(true);
  });
  it("does not flag permissive / public-domain licenses or absence", () => {
    expect(isShareAlikeLicense("CC0-1.0")).toBe(false);
    expect(isShareAlikeLicense("CC-BY-4.0")).toBe(false);
    expect(isShareAlikeLicense(undefined)).toBe(false);
  });
});
