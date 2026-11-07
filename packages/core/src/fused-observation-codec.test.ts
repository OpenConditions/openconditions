import { describe, expect, it } from "vitest";
import { fusedCodecFixture } from "./__tests__/fused-codec-fixture.js";
import { readingOf, recordOf, templateOf } from "./observation-codec.js";

type Rec = Record<string, unknown>;

describe("fused lineage storage", () => {
  it("keeps static templates identical when point and contributor IDs advance", () => {
    const first = fusedCodecFixture(),
      next = fusedCodecFixture(1);
    expect(templateOf(next)).toEqual(templateOf(first));
    const reading = readingOf(next);
    expect(reading["_ocFusionRecordIds"]).toEqual([
      `oc:observation:feed-a:${"2".repeat(64)}`,
      `oc:observation:feed-b:${"4".repeat(64)}`,
    ]);
    expect(recordOf(templateOf(next), reading)).toEqual(next);
    expect(recordOf(templateOf(first), readingOf(first))).toEqual(first);
  });

  it("retains changed credit and contributor order", () => {
    const original = fusedCodecFixture();
    const changed = structuredClone(original);
    const provenance = changed["provenance"] as Rec;
    const merged = provenance["mergedSources"] as Rec[];
    merged[1]!["attribution"] = { provider: "Revised publisher", license: "CC-BY-4.0" };
    provenance["mergedSources"] = merged.toReversed();
    (provenance["derivedFrom"] as Rec)["records"] = (
      (provenance["derivedFrom"] as Rec)["records"] as Rec[]
    ).toReversed();
    expect(templateOf(changed)).not.toEqual(templateOf(original));
    expect(recordOf(templateOf(changed), readingOf(changed))).toEqual(changed);
  });

  it("retains a new point time with the same value and sinceAt", () => {
    const first = fusedCodecFixture();
    const next = fusedCodecFixture(1);
    next["result"] = first["result"];
    next["sinceAt"] = "2026-11-04T06:35:00.000Z";
    expect(templateOf(next)).toEqual(templateOf(first));
    expect(recordOf(templateOf(next), readingOf(next))).toEqual(next);
  });

  it.each([
    "custom-record",
    "custom-identity",
    "different-reference",
    "extra-reference-field",
    "other-source",
  ])("retains %s lineage in the original representation", (shape) => {
    const record = fusedCodecFixture();
    const p = record["provenance"] as Rec;
    const refs = (p["derivedFrom"] as Rec)["records"] as Rec[];
    if (shape === "custom-record") p["recordId"] = "custom";
    if (shape === "custom-identity") {
      record["id"] = "oc:observation:publisher.test:custom";
      record["canonicalId"] = "custom-canonical-id";
    }
    if (shape === "different-reference") refs[0]!["id"] = "different";
    if (shape === "extra-reference-field") refs[0]!["role"] = "support";
    if (shape === "other-source") p["sourceId"] = "other-derived-source";
    expect(readingOf(record)["_ocFusionRecordIds"]).toBeUndefined();
    expect(recordOf(templateOf(record), readingOf(record))).toEqual(record);
    expect((templateOf(record)["provenance"] as Rec)["recordId"]).toBe(p["recordId"]);
  });
});
