import { describe, expect, it } from "vitest";
import {
  Attribution,
  PublicAttribution,
  provenanceSchema,
  publicAttributionOf,
  UpstreamPublisher,
} from "../kernel/provenance.js";
import { anyVocab } from "../kernel/vocab.js";

const captured = {
  publisher: "Actual historical author",
  license: "CC-BY-4.0",
  source: {
    sourceId: "original-child",
    attribution: {
      provider: "Exact required wording",
      name: "Original dataset",
      publisher: { name: "Actual historical author", url: "https://author.test/" },
      url: "https://source.test/original",
      license: "CC-BY-4.0",
      licenseUrl: "https://terms.test/original",
      parentSourceId: "original-parent",
      childSourceId: "original-child",
      policyIds: ["original-policy"],
    },
  },
};
describe("immutable upstream source snapshots", () => {
  it("retains exact public source identity and attribution metadata", () => {
    expect(UpstreamPublisher.safeParse(captured)).toMatchObject({ success: true, data: captured });
  });
  it("rejects nested rights evidence and conflicting permission selectors", () => {
    expect(UpstreamPublisher.safeParse({ ...captured, license: "CC0-1.0" }).success).toBe(false);
    expect(
      UpstreamPublisher.safeParse({
        ...captured,
        source: {
          ...captured.source,
          attribution: { ...captured.source.attribution, rights: { evidence_origin: "private" } },
        },
      }).success,
    ).toBe(false);
  });
  it("bounds captured IDs and rejects credential-bearing or executable source URLs", () => {
    for (const sourceId of ["x".repeat(1001), "not a source id"])
      expect(
        UpstreamPublisher.safeParse({ ...captured, source: { ...captured.source, sourceId } })
          .success,
      ).toBe(false);
    for (const url of [
      "javascript:alert(1)",
      "https://user:password@source.test/",
      "https://source.test/?api_key=secret",
    ])
      expect(
        UpstreamPublisher.safeParse({
          ...captured,
          source: { ...captured.source, attribution: { ...captured.source.attribution, url } },
        }).success,
      ).toBe(false);
  });
});

it("projects complete public captured attributes without rights or unrecognized fields", () => {
  expect(
    publicAttributionOf({
      ...captured.source.attribution,
      rights: { evidence_origin: "private-rights" },
      futureInternal: "private-future",
    } as never),
  ).toEqual(captured.source.attribution);
});

it("accepts root snapshots under the same source URL contract and rejects unsafe root links", () => {
  expect(Attribution.safeParse(captured.source.attribution).success).toBe(true);
  expect(
    PublicAttribution.safeParse(publicAttributionOf(captured.source.attribution)).success,
  ).toBe(true);
  for (const url of [
    "ftp://source.test/file",
    "https://user:password@source.test/",
    "https://source.test/?token=secret",
  ])
    expect(Attribution.safeParse({ ...captured.source.attribution, url }).success).toBe(false);
});
it("rejects root and nested source metadata whose extra licence URL would exceed portable declaration capacity", () => {
  const attribution = {
    ...captured.source.attribution,
    licensing: {
      version: 1,
      bindings: [],
      declarations: Array.from({ length: 64 }, (_, i) => ({ text: `Other declaration ${i}` })),
    },
  };
  expect(Attribution.safeParse(attribution).success).toBe(false);
  expect(PublicAttribution.safeParse(attribution).success).toBe(false);
});

it("uses identical bounded source identities for root provenance and captured upstream sources", () => {
  const schema = provenanceSchema(anyVocab, "draft");
  for (const [length, accepted] of [
    [1, true],
    [1000, true],
    [1001, false],
  ] as const) {
    const sourceId = "x".repeat(length);
    expect(
      schema.safeParse({
        origin: "feed",
        sourceId,
        sourceFormat: "test",
        accessMode: "bulk",
        recordId: "r",
        attribution: captured.source.attribution,
        privacy: { class: "authoritative" },
      }).success,
    ).toBe(accepted);
    expect(
      UpstreamPublisher.safeParse({ ...captured, source: { ...captured.source, sourceId } })
        .success,
    ).toBe(accepted);
  }
});
