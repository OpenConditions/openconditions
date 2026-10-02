import { describe, expect, it } from "vitest";
import {
  type EgressRecord,
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
    expect(isShareAlikeLicense("dl-de/zero-2-0")).toBe(false); // registry: shareAlike:false
  });

  it("falls back to substrings for a license not in the registry", () => {
    expect(isShareAlikeLicense("odbl")).toBe(true);
  });

  it("drops share-alike records from a permissive export using the registry flag", () => {
    const kept = permissiveRecords([
      { provenance: { attribution: { license: "CC-BY-SA-4.0" } } },
      { provenance: { attribution: { license: "dl-de/zero-2-0" } } },
    ]);
    expect(kept.map((r) => r.provenance.attribution.license)).toEqual(["dl-de/zero-2-0"]);
  });
});

describe("isShareAlikeLicense", () => {
  it("flags share-alike / copyleft licenses", () => {
    expect(isShareAlikeLicense("CC-BY-SA-4.0")).toBe(true);
    expect(isShareAlikeLicense("ODbL-1.0")).toBe(true);
    expect(isShareAlikeLicense("GPL-3.0")).toBe(true);
  });
  it("does not flag permissive / public-domain licenses or absence", () => {
    expect(isShareAlikeLicense("CC0-1.0")).toBe(false);
    expect(isShareAlikeLicense("CC-BY-4.0")).toBe(false);
    expect(isShareAlikeLicense(undefined)).toBe(false);
  });
});
