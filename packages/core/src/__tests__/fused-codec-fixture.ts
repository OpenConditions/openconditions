import { canonicalIdOf } from "@openconditions/model";

type Rec = Record<string, unknown>;
export function fusedCodecFixture(index = 0): Rec {
  const local = (index === 0 ? "a" : "b").repeat(64);
  const ids = [
    `oc:observation:feed-a:${(index === 0 ? "1" : "2").repeat(64)}`,
    `oc:observation:feed-b:${(index === 0 ? "3" : "4").repeat(64)}`,
  ];
  const time = index === 0 ? "2026-11-04T06:35:00.000Z" : "2026-11-04T06:40:00.000Z";
  return {
    id: `oc:observation:publisher.test:${local}`,
    canonicalId: canonicalIdOf("publisher.test", local),
    class: "observation",
    kind: "observation",
    domain: "roads",
    property: "traffic.speed",
    subject: { kind: "feature", featureId: "oc:feature:publisher.test:site" },
    location: { geometry: { type: "Point", coordinates: [5, 52] } },
    revision: 1,
    aggregation: "mean",
    temporality: "live",
    result: { type: "quantity", value: 52 + index, unit: "km/h" },
    phenomenonTime: { instant: time },
    recordedAt: time,
    freshness: { fetchedAt: time },
    contentHash: (index === 0 ? "0" : "f").repeat(64),
    provenance: {
      origin: "derived",
      sourceId: "@fused",
      sourceFormat: "derived",
      accessMode: "bulk",
      recordId: local,
      attribution: { provider: "Publisher A", license: "CC0-1.0" },
      mergedSources: ids.map((id, i) => ({
        source: i === 0 ? "feed-a" : "feed-b",
        recordId: id,
        attribution: { provider: i === 0 ? "Publisher A" : "Publisher B", license: "CC0-1.0" },
      })),
      derivedFrom: {
        records: ids.map((id) => ({ class: "observation", id })),
        method: "fusion",
        version: "1",
      },
      privacy: { class: "authoritative" },
    },
  };
}

/** Literal storage protocol fixture, independent of either codec implementation. */
export function compactFusedCodecFixture() {
  const record = fusedCodecFixture();
  const template = {
    namespace: "publisher.test",
    class: "observation",
    kind: "observation",
    domain: "roads",
    property: "traffic.speed",
    subject: record["subject"],
    location: record["location"],
    revision: 1,
    aggregation: "mean",
    temporality: "live",
    provenance: {
      origin: "derived",
      sourceId: "@fused",
      sourceFormat: "derived",
      accessMode: "bulk",
      attribution: { provider: "Publisher A", license: "CC0-1.0" },
      mergedSources: [
        { source: "feed-a", attribution: { provider: "Publisher A", license: "CC0-1.0" } },
        { source: "feed-b", attribution: { provider: "Publisher B", license: "CC0-1.0" } },
      ],
      derivedFrom: { method: "fusion", version: "1" },
      privacy: { class: "authoritative" },
    },
  };
  const reading = {
    id: "a".repeat(64),
    result: record["result"],
    phenomenonTime: record["phenomenonTime"],
    recordedAt: record["recordedAt"],
    freshness: record["freshness"],
    contentHash: record["contentHash"],
    _ocFusionRecordIds: [
      `oc:observation:feed-a:${"1".repeat(64)}`,
      `oc:observation:feed-b:${"3".repeat(64)}`,
    ],
  };
  return { record, template, reading };
}
