import { describe, expect, it } from "vitest";
import { readingOf, recordOf, templateOf } from "./observation-codec.js";

const localId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const record = {
  id: `oc:observation:publisher.test:${localId}`,
  canonicalId: "d6cc7275c8381a201684a097db3117c77609f614652f71ac81a5058715c0dbbf",
  class: "observation",
  kind: "observation",
  domain: "roads",
  property: "traffic.speed",
  subject: { kind: "feature", featureId: "oc:feature:publisher.test:site" },
  location: { geometry: { type: "Point", coordinates: [5, 52] } },
  provenance: {
    sourceId: "publisher.test",
    origin: "feed",
    recordId: "site",
    rawRef: { fetchId: 17 },
  },
  revision: 1,
  aggregation: "mean",
  temporality: "live",
  result: { type: "quantity", value: 52, unit: "km/h" },
  phenomenonTime: { start: "2026-11-04T06:34:00.000Z", end: "2026-11-04T06:35:00.000Z" },
  contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  recordedAt: "2026-11-04T06:35:05.123Z",
  freshness: { fetchedAt: "2026-11-04T06:35:00.000Z" },
};
const shared = {
  namespace: "publisher.test",
  class: record.class,
  kind: record.kind,
  domain: record.domain,
  property: record.property,
  subject: record.subject,
  location: record.location,
  provenance: { sourceId: "publisher.test", origin: "feed", recordId: "site" },
};
const {
  id: _id,
  canonicalId: _canonical,
  class: _class,
  kind: _kind,
  domain: _domain,
  property: _property,
  subject: _subject,
  location: _location,
  provenance: _provenance,
  revision,
  aggregation,
  temporality,
  ...own
} = record;
const compact = { ...own, id: localId, provenance: { rawRef: { fetchId: 17 } } };

describe("latest observation codec", () => {
  it("expands a compact reading to the original complete record", () => {
    expect(recordOf({ ...shared, revision, aggregation, temporality }, compact)).toEqual(record);
  });

  it("continues reading the original full identity and per-reading metadata", () => {
    expect(
      recordOf(shared, {
        ...compact,
        id: record.id,
        canonicalId: record.canonicalId,
        revision,
        aggregation,
        temporality,
      }),
    ).toEqual(record);
  });

  it("round trips every field while reducing repeated reading metadata", () => {
    const reading = readingOf(record);
    expect(recordOf(templateOf(record), reading)).toEqual(record);
    const legacy = {
      ...compact,
      id: record.id,
      canonicalId: record.canonicalId,
      revision,
      aggregation,
      temporality,
    };
    expect(Buffer.byteLength(JSON.stringify(reading))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(legacy)) * 0.8,
    );
  });

  it("retains a nonstandard stored identity losslessly", () => {
    const custom = { ...record, id: "oc:observation:publisher.test:custom:record" };
    expect(recordOf(templateOf(custom), readingOf(custom))).toEqual(custom);
  });
});
