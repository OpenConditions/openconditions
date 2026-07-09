import { describe, expect, it } from "vitest";
import { filterForPermissiveExport, isShareAlikeLicense } from "../license.js";
import { roadEvent } from "./fixture.js";

describe("registry-driven share-alike", () => {
  it("uses the registry flag, not substrings", () => {
    expect(isShareAlikeLicense("CC-BY-SA-4.0")).toBe(true); // registry: shareAlike:true
    expect(isShareAlikeLicense("dl-de/zero-2-0")).toBe(false); // registry: shareAlike:false
  });

  it("falls back to substrings for a license not in the registry", () => {
    expect(isShareAlikeLicense("odbl")).toBe(true);
  });

  it("drops share-alike records from a permissive export using the registry flag", () => {
    const mk = (id: string, license: string) =>
      roadEvent({ id, origin: { kind: "feed", attribution: { provider: "p", license } } });
    const kept = filterForPermissiveExport([
      mk("drop-sa", "CC-BY-SA-4.0"),
      mk("keep-zero", "dl-de/zero-2-0"),
    ]);
    expect(kept.map((o) => o.id)).toEqual(["keep-zero"]);
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

describe("filterForPermissiveExport", () => {
  it("drops share-alike records, keeps permissive + unlicensed", () => {
    const mk = (id: string, license: string) =>
      roadEvent({ id, origin: { kind: "feed", attribution: { provider: "p", license } } });
    const out = filterForPermissiveExport([
      mk("keep-cc0", "CC0-1.0"),
      mk("drop-sa", "CC-BY-SA-4.0"),
      mk("drop-odbl", "ODbL-1.0"),
      mk("keep-by", "CC-BY-4.0"),
    ]);
    expect(out.map((o) => o.id)).toEqual(["keep-cc0", "keep-by"]);
  });

  it("strips a share-alike mergedSources entry from a permissive-primary record", () => {
    const rec = roadEvent({
      id: "keep-primary",
      origin: { kind: "feed", attribution: { provider: "permissive", license: "CC-BY-4.0" } },
      mergedSources: [
        { source: "sa-src", id: "sa:1", attribution: { provider: "sa", license: "CC-BY-SA-4.0" } },
        { source: "ok-src", id: "ok:1", attribution: { provider: "ok", license: "CC-BY-4.0" } },
      ],
    });
    const out = filterForPermissiveExport([rec]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("keep-primary");
    expect(out[0]!.mergedSources?.map((m) => m.source)).toEqual(["ok-src"]);
    // non-mutating: the shared input object still carries the copyleft trace
    expect(rec.mergedSources?.map((m) => m.source)).toEqual(["sa-src", "ok-src"]);
  });

  it("still drops a record whose primary license is share-alike, mergedSources notwithstanding", () => {
    const rec = roadEvent({
      id: "drop-primary-sa",
      origin: { kind: "feed", attribution: { provider: "sa", license: "CC-BY-SA-4.0" } },
      mergedSources: [
        { source: "ok-src", id: "ok:1", attribution: { provider: "ok", license: "CC-BY-4.0" } },
      ],
    });
    expect(filterForPermissiveExport([rec])).toEqual([]);
  });

  it("returns a permissive record with only permissive mergedSources unchanged (same reference)", () => {
    const rec = roadEvent({
      id: "unchanged",
      origin: { kind: "feed", attribution: { provider: "permissive", license: "CC-BY-4.0" } },
      mergedSources: [
        { source: "ok-src", id: "ok:1", attribution: { provider: "ok", license: "CC0-1.0" } },
      ],
    });
    const out = filterForPermissiveExport([rec]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(rec);
  });
});
