import { describe, expect, it } from "vitest";
import type { LinkingRules } from "../index.js";
import {
  canonicalClusters,
  type FeatureLink,
  type LinkableFeature,
  matchOsm,
  proposeLink,
  representativePoint,
  tokenSimilarity,
} from "../index.js";

const RULES: LinkingRules = {
  idSchemes: ["ocpi:location", "osm:node"],
  alwaysMetres: 20,
  neverMetres: 150,
  attribute: { name: 0.45, operator: 0.75 },
  pendingAttribute: { name: 0.3 },
  nameStopwords: ["ladestation", "charging"],
  osm: { tags: ["amenity=charging_station"], idTags: { "ref:EU:EVSE": "emi3:evse" } },
};

const at = (lon: number, lat: number) => ({
  geometry: { type: "Point", coordinates: [lon, lat] },
  fuzziness: "exact",
});

const site = (id: string, lon: number, lat: number, rest: Partial<LinkableFeature> = {}) =>
  ({
    id,
    kind: "charging_site",
    location: at(lon, lat),
    provenance: { sourceId: id.split(":")[2] ?? "src" },
    ...rest,
  }) as LinkableFeature;

const name = (text: string) => [{ lang: "de", text }];

describe("tokenSimilarity", () => {
  it("scores a name contained in a longer one as agreement", () => {
    expect(tokenSimilarity("Parkhaus Am Markt", "Parkhaus Am Markt P2")).toBe(1);
  });

  it("ignores the words every feature of the kind carries", () => {
    const stopwords = new Set(["parkhaus"]);
    expect(tokenSimilarity("Parkhaus Nord", "Parkhaus Süd", stopwords)).toBe(0);
  });

  it("treats an absent name as no evidence, not as agreement", () => {
    expect(tokenSimilarity(undefined, "Any")).toBe(0);
    expect(tokenSimilarity("", "")).toBe(0);
  });
});

describe("representativePoint", () => {
  it("takes a point as it is and averages an outline's vertices", () => {
    expect(representativePoint({ type: "Point", coordinates: [8.4, 49] })).toEqual([8.4, 49]);
    expect(
      representativePoint({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 2],
            [2, 2],
            [2, 0],
          ],
        ],
      }),
    ).toEqual([1, 1]);
  });

  it("has no point for a geometry that is not one", () => {
    expect(representativePoint(null)).toBeUndefined();
    expect(representativePoint({ type: "GeometryCollection", geometries: [] })).toBeUndefined();
  });
});

describe("proposeLink", () => {
  it("links two sources that publish the same location id", () => {
    const a = site("oc:feature:bnetza:1", 8.4, 49, {
      externalIds: [{ scheme: "ocpi:location", id: "DE*ABC*L1" }],
    });
    const b = site("oc:feature:ocpi:2", 8.5, 49.1, {
      externalIds: [{ scheme: "ocpi:location", id: "DE*ABC*L1" }],
    });
    expect(proposeLink(a, b, RULES)).toEqual({
      aId: "oc:feature:bnetza:1",
      bId: "oc:feature:ocpi:2",
      method: "external_id",
      confidence: 1,
      status: "accepted",
      reasons: ["ocpi:location DE*ABC*L1"],
    });
  });

  it("refuses to link two different ids of one scheme, however close they are", () => {
    const a = site("oc:feature:a:1", 8.4, 49, {
      externalIds: [{ scheme: "ocpi:location", id: "DE*ABC*L1" }],
    });
    const b = site("oc:feature:b:1", 8.4, 49, {
      externalIds: [{ scheme: "ocpi:location", id: "DE*ABC*L2" }],
    });
    expect(proposeLink(a, b, RULES)).toBeUndefined();
  });

  it("links neighbours within the always-distance without any attribute", () => {
    const link = proposeLink(
      site("oc:feature:a:1", 8.4, 49),
      site("oc:feature:b:1", 8.4, 49.0001),
      RULES,
    );
    expect(link?.method).toBe("spatial_attribute");
    expect(link?.status).toBe("accepted");
    expect(link?.confidence).toBe(0.9);
  });

  it("needs an agreeing attribute between the always- and never-distance", () => {
    const far = { ...site("oc:feature:b:1", 8.4, 49.0009) };
    expect(proposeLink(site("oc:feature:a:1", 8.4, 49), far, RULES)).toBeUndefined();
    const named = { ...far, name: name("Rathausgarage") };
    const link = proposeLink(
      site("oc:feature:a:1", 8.4, 49, { name: name("Rathausgarage Ost") }),
      named,
      RULES,
    );
    expect(link?.status).toBe("accepted");
    expect(link?.confidence).toBe(0.7);
  });

  it("leaves a weak match for review instead of linking it", () => {
    const a = site("oc:feature:a:1", 8.4, 49, { name: name("Rathaus Altstadt Garage") });
    const b = site("oc:feature:b:1", 8.4, 49.0009, { name: name("Rathaus Markt Turm") });
    const link = proposeLink(a, b, RULES);
    expect(link?.status).toBe("pending");
    expect(link?.confidence).toBe(0.4);
  });

  it("never links a position that is not exactly known", () => {
    const coarse = site("oc:feature:b:1", 8.4, 49.0001);
    coarse.location = { ...coarse.location, fuzziness: "low_res" };
    expect(proposeLink(site("oc:feature:a:1", 8.4, 49), coarse, RULES)).toBeUndefined();
  });

  it("orders the pair by id, so one pair is one row", () => {
    const link = proposeLink(
      site("oc:feature:z:1", 8.4, 49),
      site("oc:feature:a:1", 8.4, 49),
      RULES,
    );
    expect([link?.aId, link?.bId]).toEqual(["oc:feature:a:1", "oc:feature:z:1"]);
  });

  describe("an id one authority issued", () => {
    const rules: LinkingRules = { ...RULES, idSchemes: ["provider"] };
    const issued = (authority: string, id: string) => ({
      externalIds: [{ scheme: "provider", id, authority }],
    });

    it("links the same id from the same authority, however far apart", () => {
      const link = proposeLink(
        site("oc:feature:a:1", 8.4, 49, issued("cpo-a", "1")),
        site("oc:feature:b:1", 8.5, 49, issued("cpo-a", "1")),
        rules,
      );
      expect(link).toMatchObject({ method: "external_id", status: "accepted" });
    });

    it("never links one id value two authorities issued", () => {
      expect(
        proposeLink(
          site("oc:feature:a:1", 8.4, 49, issued("cpo-a", "1")),
          site("oc:feature:b:1", 8.5, 49, issued("cpo-b", "1")),
          rules,
        ),
      ).toBeUndefined();
    });

    it("takes ids two authorities issued as no conflict", () => {
      const link = proposeLink(
        site("oc:feature:a:1", 8.4, 49, issued("cpo-a", "1")),
        site("oc:feature:b:1", 8.4001, 49, issued("cpo-b", "2")),
        rules,
      );
      expect(link).toMatchObject({ method: "spatial_attribute", status: "accepted" });
    });

    it("takes an id with an authority and one without as no conflict", () => {
      const link = proposeLink(
        site("oc:feature:a:1", 8.4, 49, issued("cpo-a", "1")),
        site("oc:feature:b:1", 8.4001, 49, { externalIds: [{ scheme: "provider", id: "2" }] }),
        rules,
      );
      expect(link).toMatchObject({ status: "accepted" });
    });
  });

  it("keeps apart names that differ only by a direction", () => {
    const rules: LinkingRules = { ...RULES, alwaysMetres: 20, attribute: { name: 0.45 } };
    expect(
      proposeLink(
        site("oc:feature:a:1", 8.4, 49, { name: name("Neuhaus O") }),
        site("oc:feature:a:2", 8.4015, 49, { name: name("Neuhaus W") }),
        rules,
      ),
    ).toBeUndefined();
    expect(
      proposeLink(
        site("oc:feature:a:1", 8.4, 49, { name: name("Neuhaus") }),
        site("oc:feature:b:2", 8.4015, 49, { name: name("Neuhaus W") }),
        rules,
      ),
    ).toMatchObject({ status: "accepted" });
  });
});

describe("tokenSimilarity and directions", () => {
  it("scores names with different direction markers as unrelated", () => {
    expect(tokenSimilarity("Rastplatz Nord", "Rastplatz Süd")).toBe(0);
    expect(tokenSimilarity("Neuhaus O", "Neuhaus W")).toBe(0);
    expect(tokenSimilarity("Rest Area North", "Rest Area N")).toBe(1);
  });
});

describe("canonicalClusters", () => {
  const features = [
    site("oc:feature:a:1", 8.4, 49),
    site("oc:feature:b:1", 8.4, 49.0001),
    site("oc:feature:c:1", 8.4, 49.0002),
  ];
  const link = (aId: string, bId: string): FeatureLink => ({
    aId,
    bId,
    method: "spatial_attribute",
    confidence: 0.9,
    status: "accepted",
    reasons: [],
  });

  it("gives every feature a cluster, including one nothing links to", () => {
    const clusters = canonicalClusters(features, [], { instanceId: "oc.example" });
    expect(clusters).toHaveLength(3);
    expect(clusters.every((c) => c.memberIds.length === 1)).toBe(true);
    expect(clusters[0]?.canonicalFeatureId).toMatch(/^oc:feature:oc\.example:[0-9a-f]{64}$/);
  });

  it("merges a pair and keeps the smallest id as survivor", () => {
    const clusters = canonicalClusters(features, [link("oc:feature:a:1", "oc:feature:b:1")], {
      instanceId: "oc.example",
    });
    expect(clusters.map((c) => c.memberIds)).toEqual([
      ["oc:feature:a:1", "oc:feature:b:1"],
      ["oc:feature:c:1"],
    ]);
    expect(clusters[0]?.survivorId).toBe("oc:feature:a:1");
    expect(clusters[0]?.mergedSources).toEqual([
      { source: "a", recordId: "oc:feature:a:1" },
      { source: "b", recordId: "oc:feature:b:1" },
    ]);
  });

  it("does not chain a line of pairs into one cluster", () => {
    const clusters = canonicalClusters(
      features,
      [link("oc:feature:a:1", "oc:feature:b:1"), link("oc:feature:b:1", "oc:feature:c:1")],
      { instanceId: "oc.example" },
    );
    expect(clusters.map((c) => c.memberIds.length).sort()).toEqual([1, 2]);
  });

  it("merges all three when every pair links", () => {
    const clusters = canonicalClusters(
      features,
      [
        link("oc:feature:a:1", "oc:feature:b:1"),
        link("oc:feature:b:1", "oc:feature:c:1"),
        link("oc:feature:a:1", "oc:feature:c:1"),
      ],
      { instanceId: "oc.example" },
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.memberIds).toHaveLength(3);
  });

  it("lets the caller pick the survivor", () => {
    const clusters = canonicalClusters(features, [link("oc:feature:a:1", "oc:feature:b:1")], {
      instanceId: "oc.example",
      rank: (f) => (f.id === "oc:feature:b:1" ? 1 : 0),
    });
    expect(clusters[0]?.survivorId).toBe("oc:feature:b:1");
  });
});

describe("matchOsm", () => {
  const osm = (id: string, lon: number, lat: number, tags: Record<string, string>) => ({
    id: { scheme: "osm:node" as const, id },
    tags,
    geometry: { type: "Point", coordinates: [lon, lat] },
  });

  it("matches the element that carries the publisher's own reference", () => {
    const feature = site("oc:feature:a:1", 8.0, 49.0, {
      externalIds: [{ scheme: "emi3:evse", id: "DE*ABC*E1234" }],
    });
    const match = matchOsm(
      feature,
      [osm("1", 9, 50, { amenity: "charging_station", "ref:EU:EVSE": "DE-ABC-E1234" })],
      RULES,
    );
    expect(match).toEqual({ id: { scheme: "osm:node", id: "1" }, method: "id", confidence: 1 });
  });

  it("matches a tagged element next door", () => {
    const match = matchOsm(
      site("oc:feature:a:1", 8.4, 49),
      [
        osm("1", 8.4, 49.0001, { amenity: "charging_station" }),
        osm("2", 8.4, 49, { amenity: "parking" }),
      ],
      RULES,
    );
    expect(match).toEqual({
      id: { scheme: "osm:node", id: "1" },
      method: "spatial_tag",
      confidence: 0.85,
    });
  });

  it("ignores an element of another kind, however close", () => {
    expect(
      matchOsm(site("oc:feature:a:1", 8.4, 49), [osm("2", 8.4, 49, { amenity: "parking" })], RULES),
    ).toBeUndefined();
  });

  it("needs a name or operator further out", () => {
    const far = osm("1", 8.4, 49.0009, { amenity: "charging_station" });
    expect(matchOsm(site("oc:feature:a:1", 8.4, 49), [far], RULES)).toBeUndefined();
    const match = matchOsm(
      site("oc:feature:a:1", 8.4, 49, { name: name("Rathausgarage") }),
      [{ ...far, tags: { ...far.tags, name: "Rathausgarage" } }],
      RULES,
    );
    expect(match?.method).toBe("spatial_tag");
    expect(match?.confidence).toBe(0.65);
  });
});
