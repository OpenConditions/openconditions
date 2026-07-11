import { describe, it, expect } from "vitest";
import {
  canonicalId,
  canonicalIdentityParts,
  normalizeNamespace,
  phenomenonFingerprint,
  centroid,
  gridCell,
  truncateType,
  timeBucket,
} from "../canonical.js";
import type { CanonicalIdentityParts } from "../canonical.js";
import type { ConditionEvent, Measurement, Observation } from "../model.js";

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "situation-123",
    source: "ndw",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    geometry: { type: "Point", coordinates: [6.5, 52.0] },
    status: "active",
    validFrom: "2026-07-10T12:00:00Z",
    origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-07-10T12:00:00Z",
    fetchedAt: "2026-07-10T12:01:00Z",
    isStale: false,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ConditionEvent> = {}): ConditionEvent {
  return {
    ...makeObservation(),
    kind: "event",
    type: "incident",
    subtype: "accident",
    category: "incident",
    severity: "medium",
    severitySource: "declared",
    headline: "Accident on A12",
    ...overrides,
  };
}

describe("canonicalIdentityParts", () => {
  it("namespaces feed-origin rows on the source id, ignoring instanceId", () => {
    const obs = makeObservation({ instanceId: "instance-a" });
    expect(canonicalIdentityParts(obs)).toEqual({ namespace: "ndw", recordId: "situation-123" });
  });

  it("namespaces crowd-origin rows on the originating instance", () => {
    const obs = makeObservation({
      instanceId: "maps.example.org",
      origin: {
        kind: "crowd",
        attribution: { provider: "OpenConditions", license: "ODbL-1.0" },
        reporter: { keyId: "key-1", signature: "sig-1" },
      },
    });
    expect(canonicalIdentityParts(obs)).toEqual({
      namespace: "maps.example.org",
      recordId: "situation-123",
    });
  });

  it("falls back to source for crowd-origin rows without an instanceId", () => {
    const obs = makeObservation({
      origin: {
        kind: "crowd",
        attribution: { provider: "OpenConditions", license: "ODbL-1.0" },
        reporter: { keyId: "key-1", signature: "sig-1" },
      },
    });
    expect(canonicalIdentityParts(obs)).toEqual({ namespace: "ndw", recordId: "situation-123" });
  });
});

describe("normalizeNamespace", () => {
  it("trims, unicode-normalizes, and lowercases", () => {
    expect(normalizeNamespace("  NDW ")).toBe("ndw");
    expect(normalizeNamespace("Café")).toBe(normalizeNamespace("Café"));
  });

  it("throws on an empty result", () => {
    expect(() => normalizeNamespace("   ")).toThrow();
    expect(() => normalizeNamespace("")).toThrow();
  });

  it("is idempotent when lowercasing composes a new NFC form", () => {
    const decomposed = "J" + String.fromCharCode(0x030c);
    const composedLower = String.fromCharCode(0x01f0);
    const once = normalizeNamespace(decomposed);
    expect(once).toBe(composedLower);
    expect(normalizeNamespace(once)).toBe(once);
  });
});

describe("canonicalId", () => {
  it("collapses the same upstream record resupplied through two instances", () => {
    const a = makeObservation({
      instanceId: "instance-a",
      fetchedAt: "2026-07-10T12:01:00Z",
    });
    const b = makeObservation({
      instanceId: "instance-b",
      fetchedAt: "2026-07-11T08:30:00Z",
      origin: { kind: "feed", attribution: { provider: "NDW mirror", license: "CC0-1.0" } },
    });
    expect(canonicalId(a)).toBe(canonicalId(b));
  });

  it("keeps independent crowd and official claims about one phenomenon distinct", () => {
    const official = makeObservation();
    const crowd = makeObservation({
      source: "crowd",
      instanceId: "maps.example.org",
      origin: {
        kind: "crowd",
        attribution: { provider: "OpenConditions", license: "ODbL-1.0" },
        reporter: { keyId: "key-1", signature: "sig-1" },
      },
    });
    expect(canonicalId(official)).not.toBe(canonicalId(crowd));
  });

  it("separates crowd claims with the same local id hosted on different instances", () => {
    const crowdOrigin = {
      kind: "crowd",
      attribution: { provider: "OpenConditions", license: "ODbL-1.0" },
      reporter: { keyId: "key-1", signature: "sig-1" },
    } as const;
    const onA = makeObservation({ instanceId: "instance-a", origin: crowdOrigin });
    const onB = makeObservation({ instanceId: "instance-b", origin: crowdOrigin });
    expect(canonicalId(onA)).not.toBe(canonicalId(onB));

    const rehosted = makeObservation({
      instanceId: "instance-a",
      origin: crowdOrigin,
      fetchedAt: "2026-07-12T00:00:00Z",
    });
    expect(canonicalId(onA)).toBe(canonicalId(rehosted));
  });

  it("is immune to separator injection between namespace and record id", () => {
    expect(canonicalId({ namespace: "a:b", recordId: "c" })).not.toBe(
      canonicalId({ namespace: "a", recordId: "b:c" })
    );
  });

  it("normalizes namespace case and whitespace", () => {
    expect(canonicalId({ namespace: "NDW ", recordId: "situation-123" })).toBe(
      canonicalId({ namespace: "ndw", recordId: "situation-123" })
    );
  });

  it("agrees between the observation and raw-parts paths for NFC-recomposing namespaces", () => {
    const rawNamespace = "J" + String.fromCharCode(0x030c) + "ndw";
    const obs = makeObservation({ source: rawNamespace });
    expect(canonicalId(obs)).toBe(
      canonicalId({ namespace: rawNamespace, recordId: "situation-123" })
    );
  });

  it("throws a TypeError when namespace or recordId is not a string", () => {
    expect(() =>
      canonicalId({ namespace: "ndw", recordId: 123 } as unknown as CanonicalIdentityParts)
    ).toThrow(TypeError);
    expect(() =>
      canonicalId({ namespace: 42, recordId: "situation-123" } as unknown as CanonicalIdentityParts)
    ).toThrow(TypeError);
  });

  it("matches the pinned known-answer digest", () => {
    expect(canonicalId({ namespace: "ndw", recordId: "situation-123" })).toBe(
      "fbd61b25e9b770e2f17402764326a8bcb22304148c01261123cd348ec95f8c29"
    );
    expect(canonicalId(makeObservation())).toBe(
      "fbd61b25e9b770e2f17402764326a8bcb22304148c01261123cd348ec95f8c29"
    );
  });
});

describe("phenomenonFingerprint", () => {
  it("matches nearby compatible events in the same cell and time bucket", () => {
    const a = makeEvent({ geometry: { type: "Point", coordinates: [6.4995, 52.0] } });
    const b = makeEvent({
      id: "other-id",
      geometry: { type: "Point", coordinates: [6.5, 52.0] },
      validFrom: "2026-07-10T12:02:00Z",
    });
    expect(phenomenonFingerprint(a)).toBe(phenomenonFingerprint(b));
  });

  it("separates events more than one cell apart", () => {
    const a = makeEvent({ geometry: { type: "Point", coordinates: [6.5, 52.0] } });
    const b = makeEvent({ geometry: { type: "Point", coordinates: [6.6, 52.0] } });
    expect(phenomenonFingerprint(a)).not.toBe(phenomenonFingerprint(b));
  });

  it("separates events in different 300 s buckets", () => {
    const a = makeEvent({ validFrom: "2026-07-10T12:00:00Z" });
    const b = makeEvent({ validFrom: "2026-07-10T12:10:00Z" });
    expect(phenomenonFingerprint(a)).not.toBe(phenomenonFingerprint(b));
  });

  it("separates events with a different type or domain", () => {
    const a = makeEvent();
    expect(phenomenonFingerprint(a)).not.toBe(
      phenomenonFingerprint(makeEvent({ type: "roadwork" }))
    );
    expect(phenomenonFingerprint(a)).not.toBe(
      phenomenonFingerprint(makeEvent({ domain: "transit" }))
    );
  });

  it("ignores subtype at the default type depth", () => {
    const a = makeEvent({ subtype: "accident" });
    const b = makeEvent({ subtype: "jackknifed-truck" });
    expect(phenomenonFingerprint(a)).toBe(phenomenonFingerprint(b));
  });

  it("ignores source, sourceUri, and origin entirely", () => {
    const official = makeEvent({ sourceUri: "https://ndw.nu/situation-123" });
    const crowd = makeEvent({
      source: "crowd",
      sourceUri: "https://maps.example.org/claims/9",
      origin: {
        kind: "crowd",
        attribution: { provider: "OpenConditions", license: "ODbL-1.0" },
        reporter: { keyId: "key-1", signature: "sig-1" },
      },
    });
    expect(phenomenonFingerprint(official)).toBe(phenomenonFingerprint(crowd));
  });

  it("throws a TypeError for measurements", () => {
    const measurement: Measurement = {
      ...makeObservation(),
      kind: "measurement",
      metric: "speed",
      value: 87,
      unit: "km/h",
      aggregation: "live",
    };
    expect(() => phenomenonFingerprint(measurement as unknown as ConditionEvent)).toThrow(
      TypeError
    );
  });

  it("throws a TypeError on a missing or invalid validFrom", () => {
    expect(() => phenomenonFingerprint(makeEvent({ validFrom: null }))).toThrow(TypeError);
    expect(() => phenomenonFingerprint(makeEvent({ validFrom: undefined }))).toThrow(TypeError);
    expect(() => phenomenonFingerprint(makeEvent({ validFrom: "not-a-date" }))).toThrow(TypeError);
  });

  it("matches the pinned known-answer digest", () => {
    expect(phenomenonFingerprint(makeEvent())).toBe(
      "54f9e59c114a96807ab5818a9f4a8420a7b86802db3a4f1a91c2dea54f464f8b"
    );
  });

  it("is immune to separator injection between domain and type", () => {
    const a = makeEvent({ domain: "a/b", type: "c" });
    const b = makeEvent({ domain: "a", type: "b/c" });
    expect(phenomenonFingerprint(a)).not.toBe(phenomenonFingerprint(b));
  });

  it("throws a TypeError on non-finite event coordinates", () => {
    const evt = makeEvent({ geometry: { type: "Point", coordinates: [Number.NaN, 52.0] } });
    expect(() => phenomenonFingerprint(evt)).toThrow(TypeError);
  });

  it("throws a TypeError on invalid options", () => {
    const evt = makeEvent();
    expect(() => phenomenonFingerprint(evt, { gridMeters: 0 })).toThrow(TypeError);
    expect(() => phenomenonFingerprint(evt, { gridMeters: -5 })).toThrow(TypeError);
    expect(() => phenomenonFingerprint(evt, { gridMeters: Number.POSITIVE_INFINITY })).toThrow(
      TypeError
    );
    expect(() => phenomenonFingerprint(evt, { timeBucketSec: 0 })).toThrow(TypeError);
    expect(() => phenomenonFingerprint(evt, { timeBucketSec: Number.NaN })).toThrow(TypeError);
    expect(() => phenomenonFingerprint(evt, { typeDepth: 3 })).toThrow(TypeError);
    expect(() => phenomenonFingerprint(evt, { typeDepth: 1.5 })).toThrow(TypeError);
    expect(() => phenomenonFingerprint(evt, { typeDepth: 0 })).toThrow(TypeError);
  });

  it("merges with gridMeters=1000 what the 100 m default separates", () => {
    const a = makeEvent({ geometry: { type: "Point", coordinates: [6.5, 52.0] } });
    const b = makeEvent({ geometry: { type: "Point", coordinates: [6.502, 52.0] } });
    expect(phenomenonFingerprint(a)).not.toBe(phenomenonFingerprint(b));
    expect(phenomenonFingerprint(a, { gridMeters: 1000 })).toBe(
      phenomenonFingerprint(b, { gridMeters: 1000 })
    );
  });

  it("separates with timeBucketSec=60 what the 300 s default merges", () => {
    const a = makeEvent({ validFrom: "2026-07-10T12:00:00Z" });
    const b = makeEvent({ validFrom: "2026-07-10T12:02:00Z" });
    expect(phenomenonFingerprint(a)).toBe(phenomenonFingerprint(b));
    expect(phenomenonFingerprint(a, { timeBucketSec: 60 })).not.toBe(
      phenomenonFingerprint(b, { timeBucketSec: 60 })
    );
  });

  it("groups by domain only at typeDepth=1", () => {
    const a = makeEvent({ type: "incident" });
    const b = makeEvent({ type: "roadwork" });
    expect(phenomenonFingerprint(a, { typeDepth: 1 })).toBe(
      phenomenonFingerprint(b, { typeDepth: 1 })
    );
  });
});

describe("centroid", () => {
  it("averages all vertices of a MultiLineString", () => {
    expect(
      centroid({
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0],
            [2, 0],
          ],
          [
            [4, 4],
            [6, 4],
          ],
        ],
      })
    ).toEqual([3, 2]);
  });

  it("averages across a GeometryCollection", () => {
    expect(
      centroid({
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [0, 0] },
          {
            type: "LineString",
            coordinates: [
              [2, 2],
              [4, 4],
            ],
          },
        ],
      })
    ).toEqual([2, 2]);
  });

  it("handles Polygon and MultiPolygon rings", () => {
    expect(
      centroid({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
          ],
        ],
      })
    ).toEqual([1, 1]);
  });

  it("throws a TypeError on a geometry with no positions", () => {
    expect(() => centroid({ type: "GeometryCollection", geometries: [] })).toThrow(TypeError);
  });
});

describe("gridCell", () => {
  it("snaps to the equatorial-scaled grid", () => {
    expect(gridCell([6.5, 52.0], 100)).toBe("7235:57886");
  });

  it("throws a TypeError on non-finite coordinates", () => {
    expect(() => gridCell([Number.NaN, 52.0], 100)).toThrow(TypeError);
    expect(() => gridCell([6.5, Number.POSITIVE_INFINITY], 100)).toThrow(TypeError);
  });
});

describe("truncateType", () => {
  it("keeps domain and type as separate parts at depth 2, domain only at depth 1", () => {
    expect(truncateType("roads", "incident", 2)).toEqual(["roads", "incident"]);
    expect(truncateType("roads", "incident", 1)).toEqual(["roads"]);
  });
});

describe("timeBucket", () => {
  it("buckets epoch seconds", () => {
    expect(timeBucket("2026-07-10T12:00:00Z", 300)).toBe(5945616);
    expect(timeBucket("2026-07-10T12:02:00Z", 300)).toBe(5945616);
    expect(timeBucket("2026-07-10T12:10:00Z", 300)).toBe(5945618);
  });

  it("parses offset-less timestamps as UTC regardless of host timezone", () => {
    expect(timeBucket("2026-07-10T12:00:00", 300)).toBe(timeBucket("2026-07-10T12:00:00Z", 300));
  });

  it("respects explicit UTC offsets", () => {
    expect(timeBucket("2026-07-10T14:00:00+02:00", 300)).toBe(
      timeBucket("2026-07-10T12:00:00Z", 300)
    );
    expect(timeBucket("2026-07-10T14:00:00+0200", 300)).toBe(
      timeBucket("2026-07-10T12:00:00Z", 300)
    );
  });

  it("throws a TypeError on missing or invalid input", () => {
    expect(() => timeBucket(undefined, 300)).toThrow(TypeError);
    expect(() => timeBucket(null, 300)).toThrow(TypeError);
    expect(() => timeBucket("not-a-date", 300)).toThrow(TypeError);
  });
});
