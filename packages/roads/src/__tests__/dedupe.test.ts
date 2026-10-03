import { describe, expect, it } from "vitest";
import { dedupeRoadEvents } from "../dedupe.js";
import type { RoadEvent } from "../model.js";

function makeRoadEvent(overrides: Partial<RoadEvent> & { lng: number; lat: number }): RoadEvent {
  const { lng, lat, ...rest } = overrides;
  return {
    id: `road-${Math.random().toString(36).slice(2)}`,
    source: "test-source",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    type: "accident",
    subtype: undefined,
    category: "incident",
    severity: "medium",
    severitySource: "declared",
    headline: "Accident",
    isPlanned: false,
    roads: [],
    geometry: { type: "Point", coordinates: [lng, lat] },
    status: "active",
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

describe("dedupeRoadEvents", () => {
  it("merges two RoadEvents at the same coords with the same type", () => {
    const a = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "accident" });
    const b = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "accident" });

    const result = dedupeRoadEvents([a, b]);
    expect(result).toHaveLength(1);
  });

  it("keeps two RoadEvents at the same coords with different types separate", () => {
    const a = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "accident" });
    const b = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "roadworks" });

    const result = dedupeRoadEvents([a, b]);
    expect(result).toHaveLength(2);
  });

  it("keeps same-type events at the same coords with dissimilar headlines separate", () => {
    // Road events carry their text in `headline` (not `label`), so the within-
    // source text guard must compare headlines — otherwise two unrelated works
    // reported at the same coordinate wrongly collapse into one.
    const a = makeRoadEvent({
      lng: 4.9,
      lat: 52.3,
      type: "roadworks",
      headline: "Resurfacing northbound lane between Tempo Road and Clearwater",
    });
    const b = makeRoadEvent({
      lng: 4.9,
      lat: 52.3,
      type: "roadworks",
      headline: "Bridge joint replacement southbound ramp closure detour",
    });

    const result = dedupeRoadEvents([a, b]);
    expect(result).toHaveLength(2);
  });

  it("still merges genuine duplicates with near-identical headlines", () => {
    const headline = "Daily construction on HWY 17 eastbound between Terrace and Schreiber";
    const a = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "roadworks", headline });
    const b = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "roadworks", headline });

    const result = dedupeRoadEvents([a, b]);
    expect(result).toHaveLength(1);
  });

  it("merges two events 20 m apart, keeping the one updated last", () => {
    const older = makeRoadEvent({ lng: 4.9, lat: 52.3, dataUpdatedAt: "2026-01-01T10:00:00Z" });
    const newer = makeRoadEvent({
      lng: 4.900178,
      lat: 52.3,
      dataUpdatedAt: "2026-01-01T12:00:00Z",
    });

    const result = dedupeRoadEvents([older, newer]);
    expect(result).toHaveLength(1);
    expect(result[0]!.dataUpdatedAt).toBe("2026-01-01T12:00:00Z");
  });

  it("keeps two events 500 m apart separate", () => {
    const a = makeRoadEvent({ lng: 4.9, lat: 52.3 });
    const b = makeRoadEvent({ lng: 4.9, lat: 52.3045 });

    expect(dedupeRoadEvents([a, b])).toHaveLength(2);
  });

  it("does not over-merge a transitive A-B-C chain when A-C exceeds the distance threshold", () => {
    // At lat 52.3, 1° lng ≈ 67 930 m: A–B ≈ 40 m, B–C ≈ 40 m, A–C ≈ 80 m (> 60 m).
    // Only the all-pairs guard keeps the chain from collapsing into one.
    const A = makeRoadEvent({ lng: 4.9, lat: 52.3 });
    const B = makeRoadEvent({ lng: 4.900589, lat: 52.3 });
    const C = makeRoadEvent({ lng: 4.901178, lat: 52.3 });

    expect(dedupeRoadEvents([A, B, C])).toHaveLength(2);
  });

  it("returns an empty array for no events", () => {
    expect(dedupeRoadEvents([])).toEqual([]);
  });
});
