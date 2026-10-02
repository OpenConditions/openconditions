import { describe, expect, it } from "vitest";
import type { CanonicalIdentityParts } from "../canonical.js";
import {
  canonicalId,
  canonicalIdentityParts,
  centroid,
  coarseCell,
  gridCell,
  isoUtcEpochMs,
  normalizeNamespace,
} from "../canonical.js";
import type { Observation } from "../model.js";

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

describe("canonicalIdentityParts", () => {
  it("namespaces rows on the source id, ignoring instanceId", () => {
    const obs = makeObservation({ instanceId: "instance-a" });
    expect(canonicalIdentityParts(obs)).toEqual({ namespace: "ndw", recordId: "situation-123" });
  });
});

describe("normalizeNamespace", () => {
  it("trims, unicode-normalizes, and lowercases", () => {
    expect(normalizeNamespace("  NDW ")).toBe("ndw");
    expect(normalizeNamespace("Café")).toBe(normalizeNamespace("Café"));
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

  it("separates one local id published by different sources", () => {
    expect(canonicalId(makeObservation())).not.toBe(
      canonicalId(makeObservation({ source: "autobahn" })),
    );
  });

  it("is immune to separator injection between namespace and record id", () => {
    expect(canonicalId({ namespace: "a:b", recordId: "c" })).not.toBe(
      canonicalId({ namespace: "a", recordId: "b:c" }),
    );
  });

  it("normalizes namespace case and whitespace", () => {
    expect(canonicalId({ namespace: "NDW ", recordId: "situation-123" })).toBe(
      canonicalId({ namespace: "ndw", recordId: "situation-123" }),
    );
  });

  it("agrees between the observation and raw-parts paths for NFC-recomposing namespaces", () => {
    const rawNamespace = "J" + String.fromCharCode(0x030c) + "ndw";
    const obs = makeObservation({ source: rawNamespace });
    expect(canonicalId(obs)).toBe(
      canonicalId({ namespace: rawNamespace, recordId: "situation-123" }),
    );
  });

  it("throws a TypeError when namespace or recordId is not a string", () => {
    expect(() =>
      canonicalId({ namespace: "ndw", recordId: 123 } as unknown as CanonicalIdentityParts),
    ).toThrow(TypeError);
    expect(() =>
      canonicalId({
        namespace: 42,
        recordId: "situation-123",
      } as unknown as CanonicalIdentityParts),
    ).toThrow(TypeError);
  });

  it("matches the pinned known-answer digest", () => {
    expect(canonicalId({ namespace: "ndw", recordId: "situation-123" })).toBe(
      "fbd61b25e9b770e2f17402764326a8bcb22304148c01261123cd348ec95f8c29",
    );
    expect(canonicalId(makeObservation())).toBe(
      "fbd61b25e9b770e2f17402764326a8bcb22304148c01261123cd348ec95f8c29",
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
      }),
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
      }),
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
      }),
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

describe("coarseCell", () => {
  it("is deterministic for the same coordinates", () => {
    expect(coarseCell(4.4961, 52.0)).toBe(coarseCell(4.4961, 52.0));
  });

  it("buckets two points ~100m apart into the same ~1km cell", () => {
    expect(coarseCell(4.4961, 52.0)).toBe(coarseCell(4.497, 52.0));
  });

  it("separates two points ~5km apart into different cells", () => {
    expect(coarseCell(4.4961, 52.0)).not.toBe(coarseCell(4.5411, 52.0));
    expect(coarseCell(4.4961, 52.0)).not.toBe(coarseCell(4.4961, 52.045));
  });

  it("defaults to the 1km grid and agrees with gridCell's quantization", () => {
    expect(coarseCell(6.5, 52.0)).toBe(coarseCell(6.5, 52.0, 1000));
    expect(coarseCell(6.5, 52.0, 100)).toBe(gridCell([6.5, 52.0], 100));
  });

  it("throws a TypeError on non-finite coordinates", () => {
    expect(() => coarseCell(Number.NaN, 52.0)).toThrow(TypeError);
    expect(() => coarseCell(6.5, Number.NEGATIVE_INFINITY)).toThrow(TypeError);
  });
});

describe("isoUtcEpochMs", () => {
  it("parses a zoned ISO timestamp", () => {
    expect(isoUtcEpochMs("2026-07-10T12:00:00Z")).toBe(Date.UTC(2026, 6, 10, 12));
  });

  it("parses offset-less timestamps as UTC regardless of host timezone", () => {
    // Force a non-UTC zone so this stays diagnostic on a UTC CI runner: Node
    // applies process.env.TZ to Date.parse immediately, so a regression that let
    // the legacy parser interpret the offset-less string in local time would make
    // the two values diverge here.
    const prevTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(isoUtcEpochMs("2026-07-10T12:00:00")).toBe(isoUtcEpochMs("2026-07-10T12:00:00Z"));
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  it("accepts a date-only ISO string (UTC midnight)", () => {
    expect(isoUtcEpochMs("2026-07-10")).toBe(isoUtcEpochMs("2026-07-10T00:00:00Z"));
  });

  it("rejects non-ISO-shaped date strings instead of falling through to the legacy parser", () => {
    expect(isoUtcEpochMs("07/10/2026")).toBeNaN();
    expect(isoUtcEpochMs("Fri Jul 10 2026")).toBeNaN();
    expect(isoUtcEpochMs("July 10, 2026")).toBeNaN();
  });

  it("respects explicit UTC offsets", () => {
    expect(isoUtcEpochMs("2026-07-10T14:00:00+02:00")).toBe(isoUtcEpochMs("2026-07-10T12:00:00Z"));
    expect(isoUtcEpochMs("2026-07-10T14:00:00+0200")).toBe(isoUtcEpochMs("2026-07-10T12:00:00Z"));
  });

  it("returns NaN for unparseable input", () => {
    expect(isoUtcEpochMs("not-a-date")).toBeNaN();
    expect(isoUtcEpochMs("2026-13-45T99:00:00Z")).toBeNaN();
  });
});
