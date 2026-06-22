import { describe, it, expect } from "vitest";
import type { Observation } from "../model.js";
import { dedupeObservations } from "../dedupe.js";

function makeObs(overrides: Partial<Observation> & { lng: number; lat: number }): Observation {
  const { lng, lat, ...rest } = overrides;
  return {
    id: `obs-${Math.random().toString(36).slice(2)}`,
    source: "test-source",
    sourceFormat: "native",
    domain: "roads",
    kind: "event",
    geometry: { type: "Point", coordinates: [lng, lat] },
    status: "active",
    label: undefined,
    origin: {
      kind: "feed",
      attribution: { provider: "Test", license: "CC0-1.0" },
    },
    dataUpdatedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
    isStale: false,
    ...rest,
  };
}

describe("dedupeObservations", () => {
  it("merges two observations 20 m apart with the same label, keeping the newer dataUpdatedAt", () => {
    const older = makeObs({
      id: "obs-older",
      lng: 4.9,
      lat: 52.3,
      source: "source-a",
      label: "roadworks on A10",
      dataUpdatedAt: "2026-01-01T10:00:00Z",
    });
    const newer = makeObs({
      id: "obs-newer",
      lng: 4.900178,
      lat: 52.3,
      source: "source-b",
      label: "roadworks on A10",
      dataUpdatedAt: "2026-01-01T12:00:00Z",
    });

    const result = dedupeObservations([older, newer]);
    expect(result).toHaveLength(1);
    expect(result[0]!.dataUpdatedAt).toBe("2026-01-01T12:00:00Z");
  });

  it("keeps two observations 500 m apart as separate entries", () => {
    const a = makeObs({ lng: 4.9, lat: 52.3 });
    const b = makeObs({ lng: 4.9, lat: 52.3045 });

    const result = dedupeObservations([a, b]);
    expect(result).toHaveLength(2);
  });

  it("does not merge two observations at the same coords when sameType returns false", () => {
    const a = makeObs({ lng: 4.9, lat: 52.3 });
    const b = makeObs({ lng: 4.9, lat: 52.3 });

    const result = dedupeObservations([a, b], {
      sameType: () => false,
    });
    expect(result).toHaveLength(2);
  });

  it("does not over-merge a transitive A-B-C chain when A-C exceeds the distance threshold", () => {
    // At lat 52.3, 1° lng ≈ 67 930 m.
    // A–B ≈ 40 m (<60 m), B–C ≈ 40 m (<60 m), A–C ≈ 80 m (>60 m).
    // All three share the same label so only the pure-distance all-pairs guard
    // prevents the full chain from collapsing. Expected: B merges with A or C
    // but A and C remain in separate clusters → exactly 2 clusters.
    const A = makeObs({ lng: 4.9, lat: 52.3, label: "incident north" });
    const B = makeObs({ lng: 4.900589, lat: 52.3, label: "incident north" });
    const C = makeObs({ lng: 4.901178, lat: 52.3, label: "incident north" });

    const result = dedupeObservations([A, B, C]);
    expect(result).toHaveLength(2);
  });

  it("merges when one label is absent (label absence is a pass)", () => {
    const a = makeObs({ lng: 4.9, lat: 52.3, label: "some label" });
    const b = makeObs({ lng: 4.9, lat: 52.3, label: undefined });

    const result = dedupeObservations([a, b]);
    expect(result).toHaveLength(1);
  });

  it("does not merge when both labels are present but dissimilar (Jaccard < 0.5)", () => {
    const a = makeObs({ lng: 4.9, lat: 52.3, label: "accident on motorway" });
    const b = makeObs({ lng: 4.9, lat: 52.3, label: "roadworks bridge closure detour bypass" });

    const result = dedupeObservations([a, b]);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(dedupeObservations([])).toEqual([]);
  });
});
