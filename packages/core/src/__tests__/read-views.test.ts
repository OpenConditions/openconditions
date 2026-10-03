import { describe, expect, it } from "vitest";
import { canonicalFeatureRecord, withoutComponents } from "../features.js";
import { seriesResolution } from "../observations.js";

type Rec = Record<string, unknown>;

const CANONICAL = `oc:feature:test.local:${"a".repeat(64)}`;

function station(id: string, source: string, keys: string[], license = "CC-BY-4.0"): Rec {
  return {
    id,
    class: "feature",
    kind: "fuel_station",
    canonicalId: "x",
    components: keys.map((key) => ({
      key,
      kind: "fuel_product",
      details: { kind: "fuel_product", v: 1, grade: key },
    })),
    provenance: { sourceId: source, attribution: { provider: source, license } },
  };
}

const cluster = {
  canonicalFeatureId: CANONICAL,
  survivorId: "oc:feature:a:1",
  memberIds: ["oc:feature:a:1", "oc:feature:b:1"],
  components: [
    {
      key: "e5",
      kind: "fuel_product",
      members: [
        { featureId: "oc:feature:a:1", key: "e5" },
        { featureId: "oc:feature:b:1", key: "E5" },
      ],
    },
    {
      key: "b/diesel",
      kind: "fuel_product",
      members: [{ featureId: "oc:feature:b:1", key: "diesel" }],
    },
  ],
};

describe("canonicalFeatureRecord", () => {
  const a = station("oc:feature:a:1", "a", ["e5"]);
  const b = station("oc:feature:b:1", "b", ["E5", "diesel"]);

  it("is the survivor under the canonical id, with the union of components and the members credited", () => {
    const record = canonicalFeatureRecord(cluster, [a, b])!;
    expect(record["id"]).toBe(CANONICAL);
    expect(record["canonicalId"]).toMatch(/^[0-9a-f]{64}$/);
    expect((record["components"] as Rec[]).map((c) => c["key"])).toEqual(["e5", "b/diesel"]);
    expect(record["provenance"]).toMatchObject({
      sourceId: "a",
      mergedSources: [
        {
          source: "b",
          recordId: "oc:feature:b:1",
          attribution: { provider: "b", license: "CC-BY-4.0" },
          link: "same_asset",
        },
      ],
      derivedFrom: {
        records: [
          { class: "feature", id: "oc:feature:a:1" },
          { class: "feature", id: "oc:feature:b:1" },
        ],
        method: "canonical_view",
        version: "1",
      },
    });
  });

  it("takes neither components nor credit from a member it is not given", () => {
    const record = canonicalFeatureRecord(cluster, [a])!;
    expect((record["components"] as Rec[]).map((c) => c["key"])).toEqual(["e5"]);
    expect((record["provenance"] as Rec)["mergedSources"]).toBeUndefined();
  });

  it("stands on the first member left when the survivor is not given, and on none without members", () => {
    const record = canonicalFeatureRecord(cluster, [b])!;
    expect((record["provenance"] as Rec)["sourceId"]).toBe("b");
    expect((record["components"] as Rec[]).map((c) => c["key"])).toEqual(["e5", "b/diesel"]);
    expect(canonicalFeatureRecord(cluster, [])).toBeUndefined();
  });

  it("leaves a collection's record without its components", () => {
    expect(withoutComponents(a)["components"]).toBeUndefined();
    expect(withoutComponents(a)["id"]).toBe("oc:feature:a:1");
  });
});

describe("seriesResolution", () => {
  const speed = { retention: { rawDays: 3, rollup: { period: "hourly" as const } } };
  const status = { retention: { changeOnly: true } };
  const now = new Date("2026-09-22T12:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it("reads raw readings within the raw retention, the rollup beyond it", () => {
    expect(seriesResolution(speed, { from: daysAgo(2), now })).toBe("raw");
    expect(seriesResolution(speed, { from: daysAgo(4), now })).toBe("hourly");
  });

  it("reads raw readings of a property kept for good, or without a rollup", () => {
    expect(seriesResolution(status, { from: daysAgo(400), now })).toBe("raw");
    expect(seriesResolution({ retention: { rawDays: 3 } }, { from: daysAgo(30), now })).toBe("raw");
  });

  it("takes the resolution asked for when the property keeps it", () => {
    expect(seriesResolution(speed, { from: daysAgo(1), now, requested: "hourly" })).toBe("hourly");
    expect(seriesResolution(speed, { from: daysAgo(9), now, requested: "raw" })).toBe("raw");
    expect(seriesResolution(speed, { from: daysAgo(1), now, requested: "daily" })).toBeUndefined();
  });
});
