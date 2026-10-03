import { describe, expect, it } from "vitest";
import type { CanonicalCluster } from "../linking/cluster.js";
import { type ComponentHolder, canonicalComponents } from "../linking/components.js";
import { crowdRegistry } from "./crowd-fixtures.js";

const cluster = (survivorId: string, memberIds: string[]): CanonicalCluster => ({
  canonicalFeatureId: "oc:feature:oc.example.org:c1",
  survivorId,
  memberIds: [...memberIds].sort(),
  mergedSources: [],
});

const cpo: ComponentHolder = {
  id: "oc:feature:de-bw-ocpdb:LOC1",
  provenance: { sourceId: "de-bw-ocpdb" },
  components: [
    {
      key: "1",
      kind: "evse",
      externalIds: [{ scheme: "emi3:evse", id: "DE*ABC*E1" }],
      details: {},
    },
    {
      key: "1-1",
      parentKey: "1",
      kind: "connector",
      externalIds: [{ scheme: "ocpi:connector", id: "1" }],
      details: { standard: "IEC_62196_T2" },
    },
    {
      key: "2",
      kind: "evse",
      externalIds: [{ scheme: "emi3:evse", id: "DE*ABC*E2" }],
      details: {},
    },
    {
      key: "2-1",
      parentKey: "2",
      kind: "connector",
      externalIds: [{ scheme: "ocpi:connector", id: "1" }],
      details: { standard: "IEC_62196_T2" },
    },
  ],
};

const aggregator: ComponentHolder = {
  id: "oc:feature:de-aggregator:9",
  provenance: { sourceId: "de-aggregator" },
  components: [
    {
      key: "A",
      kind: "evse",
      externalIds: [{ scheme: "emi3:evse", id: "DE*ABC*E2" }],
      details: {},
    },
    {
      key: "A1",
      parentKey: "A",
      kind: "connector",
      externalIds: [{ scheme: "ocpi:connector", id: "1" }],
      details: { standard: "IEC_62196_T2" },
    },
    {
      key: "B",
      kind: "evse",
      externalIds: [{ scheme: "emi3:evse", id: "DE*ABC*E9" }],
      details: {},
    },
  ],
};

describe("canonical components", () => {
  it("keeps the survivor's keys, matches by shared ids within the matched parent, and adds the rest", () => {
    const set = canonicalComponents(crowdRegistry, cluster(cpo.id, [cpo.id, aggregator.id]), [
      cpo,
      aggregator,
    ]);
    expect(set).toEqual([
      { key: "1", kind: "evse", members: [{ featureId: cpo.id, key: "1" }] },
      {
        key: "2",
        kind: "evse",
        members: [
          { featureId: cpo.id, key: "2" },
          { featureId: aggregator.id, key: "A" },
        ],
      },
      {
        key: "1-1",
        kind: "connector",
        parentKey: "1",
        members: [{ featureId: cpo.id, key: "1-1" }],
      },
      {
        key: "2-1",
        kind: "connector",
        parentKey: "2",
        members: [
          { featureId: cpo.id, key: "2-1" },
          { featureId: aggregator.id, key: "A1" },
        ],
      },
      { key: "de-aggregator/B", kind: "evse", members: [{ featureId: aggregator.id, key: "B" }] },
    ]);
  });

  it("never matches by position or name, only by identity fields where a kind has no ids", () => {
    const station = (
      id: string,
      sourceId: string,
      grades: [string, string?][],
    ): ComponentHolder => ({
      id,
      provenance: { sourceId },
      components: grades.map(([grade, service], i) => ({
        key: `p${i}`,
        kind: "fuel_product",
        details: { grade, ...(service === undefined ? {} : { service }) },
      })),
    });
    const a = station("oc:feature:it-mimit:1", "it-mimit", [
      ["e5", "self"],
      ["e5", "served"],
    ]);
    const b = station("oc:feature:it-osm:1", "it-osm", [["e5", "served"], ["diesel"]]);
    const set = canonicalComponents(crowdRegistry, cluster(a.id, [a.id, b.id]), [a, b]);
    expect(set.map((c) => [c.key, c.members.map((m) => m.key)])).toEqual([
      ["p0", ["p0"]],
      ["p1", ["p1", "p0"]],
      ["it-osm/p1", ["p1"]],
    ]);
  });

  it("gives every component one canonical key even when two members share a source", () => {
    const twin: ComponentHolder = {
      id: "oc:feature:de-aggregator:10",
      provenance: { sourceId: "de-aggregator" },
      components: [
        {
          key: "B",
          kind: "evse",
          externalIds: [{ scheme: "emi3:evse", id: "DE*ABC*E10" }],
          details: {},
        },
      ],
    };
    const set = canonicalComponents(
      crowdRegistry,
      cluster(cpo.id, [cpo.id, aggregator.id, twin.id]),
      [cpo, aggregator, twin],
    );
    const keys = set.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    // Members after the survivor go in id order: ":10" sorts before ":9" and takes the source key.
    expect(keys).toEqual(expect.arrayContaining(["de-aggregator/B", "9/B"]));
  });
});

describe("canonical components and id authority", () => {
  const holder = (id: string, authority: string): ComponentHolder => ({
    id,
    provenance: { sourceId: id.split(":")[2]! },
    components: [
      {
        key: "1",
        kind: "evse",
        externalIds: [{ scheme: "ocpi:evse", id: "1", authority }],
        details: {},
      },
    ],
  });

  it("never takes one uid two operators issued for one component", () => {
    const a = holder("oc:feature:cpo-a:L1", "DE*AAA");
    const b = holder("oc:feature:cpo-b:L1", "DE*BBB");
    const set = canonicalComponents(crowdRegistry, cluster(a.id, [a.id, b.id]), [a, b]);
    expect(set.map((c) => c.members.length)).toEqual([1, 1]);
  });

  it("takes one uid one operator issued as one component", () => {
    const a = holder("oc:feature:cpo-a:L1", "DE*AAA");
    const b = holder("oc:feature:agg:L9", "DE*AAA");
    const set = canonicalComponents(crowdRegistry, cluster(a.id, [a.id, b.id]), [a, b]);
    expect(set.map((c) => c.members.length)).toEqual([2]);
  });
});
