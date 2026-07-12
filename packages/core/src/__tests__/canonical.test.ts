import { describe, it, expect } from "vitest";
import {
  canonicalId,
  canonicalIdentityParts,
  normalizeNamespace,
  phenomenonFingerprint,
  phenomenonFingerprintNeighborhood,
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

describe("phenomenonFingerprintNeighborhood", () => {
  const METERS_PER_DEG_LAT = 111_320;

  it("includes the event's own fingerprint", () => {
    const evt = makeEvent();
    expect(phenomenonFingerprintNeighborhood(evt)).toContain(phenomenonFingerprint(evt));
  });

  it("returns at most 27 distinct fingerprints (3x3 cells x 3 buckets)", () => {
    const fps = phenomenonFingerprintNeighborhood(makeEvent());
    expect(fps.length).toBeLessThanOrEqual(27);
    expect(new Set(fps).size).toBe(fps.length);
  });

  it("closes the cell-boundary miss: two events 1 m apart across a cell edge each contain the other's own fingerprint", () => {
    // 100 m grid → one longitude cell ≈ 0.000898°. Straddle a cell edge by ~1 m.
    const lonStep = 100 / METERS_PER_DEG_LAT;
    const edgeLon = Math.ceil(6.5 / lonStep) * lonStep;
    const a = makeEvent({ geometry: { type: "Point", coordinates: [edgeLon - 0.000005, 52.0] } });
    const b = makeEvent({
      id: "other-id",
      geometry: { type: "Point", coordinates: [edgeLon + 0.000005, 52.0] },
    });
    // Their exact fingerprints differ (different cells)...
    expect(phenomenonFingerprint(a)).not.toBe(phenomenonFingerprint(b));
    // ...yet each sits in the other's neighborhood.
    expect(phenomenonFingerprintNeighborhood(a)).toContain(phenomenonFingerprint(b));
    expect(phenomenonFingerprintNeighborhood(b)).toContain(phenomenonFingerprint(a));
  });

  it("yields all 9 cells for a centroid within 1e-12° of a cell edge at lon ≈ −179.974", () => {
    // Near |lon| ≈ 180 a coordinate-offset implementation can lose a ±step
    // offset to floating-point cancellation and skip a neighbor cell. Integer
    // cell-index offsets must keep the full 3×3 block regardless.
    const step = 100 / METERS_PER_DEG_LAT;
    const edgeLon = Math.floor(-179.974 / step) * step;
    const lonC = edgeLon + 1e-12;
    const latC = (Math.floor(52.0 / step) + 0.5) * step;
    const base = makeEvent({ geometry: { type: "Point", coordinates: [lonC, latC] } });
    const hood = phenomenonFingerprintNeighborhood(base);
    expect(hood).toHaveLength(27);

    // Re-derive the base cell exactly as gridCell does, then demand the
    // fingerprint of an event at the CENTER of each of the 9 surrounding cells.
    const x = Math.floor(lonC / step);
    const y = Math.floor(latC / step);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighbor = makeEvent({
          id: `cell-${dx}-${dy}`,
          geometry: {
            type: "Point",
            coordinates: [(x + dx + 0.5) * step, (y + dy + 0.5) * step],
          },
        });
        expect(hood).toContain(phenomenonFingerprint(neighbor));
      }
    }
  });

  it("includes the ±1 time buckets", () => {
    const at = makeEvent({ validFrom: "2026-07-10T12:00:00Z" });
    const prev = makeEvent({ validFrom: "2026-07-10T11:55:00Z" });
    const next = makeEvent({ validFrom: "2026-07-10T12:05:00Z" });
    const hood = phenomenonFingerprintNeighborhood(at);
    expect(hood).toContain(phenomenonFingerprint(prev));
    expect(hood).toContain(phenomenonFingerprint(next));
    // ...but not two buckets away.
    const farPast = makeEvent({ validFrom: "2026-07-10T11:49:00Z" });
    expect(hood).not.toContain(phenomenonFingerprint(farPast));
  });

  it("carries the same TypeError guards as phenomenonFingerprint", () => {
    expect(() => phenomenonFingerprintNeighborhood(makeEvent({ validFrom: null }))).toThrow(
      TypeError
    );
    expect(() =>
      phenomenonFingerprintNeighborhood(
        makeEvent({ geometry: { type: "Point", coordinates: [Number.NaN, 52.0] } })
      )
    ).toThrow(TypeError);
    expect(() => phenomenonFingerprintNeighborhood(makeEvent(), { gridMeters: 0 })).toThrow(
      TypeError
    );
    expect(() => phenomenonFingerprintNeighborhood(makeEvent(), { typeDepth: 3 })).toThrow(
      TypeError
    );
    const measurement: Measurement = {
      ...makeObservation(),
      kind: "measurement",
      metric: "speed",
      value: 87,
      unit: "km/h",
      aggregation: "live",
    };
    expect(() =>
      phenomenonFingerprintNeighborhood(measurement as unknown as ConditionEvent)
    ).toThrow(TypeError);
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
    // Force a non-UTC zone so this stays diagnostic on a UTC CI runner: Node
    // applies process.env.TZ to Date.parse immediately, so a regression that let
    // the legacy parser interpret the offset-less string in local time would make
    // the two buckets diverge here.
    const prevTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(timeBucket("2026-07-10T12:00:00", 300)).toBe(timeBucket("2026-07-10T12:00:00Z", 300));
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  it("accepts a date-only ISO string (UTC midnight)", () => {
    expect(timeBucket("2026-07-10", 300)).toBe(timeBucket("2026-07-10T00:00:00Z", 300));
  });

  it("rejects non-ISO-shaped date strings instead of falling through to the legacy parser", () => {
    expect(() => timeBucket("07/10/2026", 300)).toThrow(TypeError);
    expect(() => timeBucket("Fri Jul 10 2026", 300)).toThrow(TypeError);
    expect(() => timeBucket("July 10, 2026", 300)).toThrow(TypeError);
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
