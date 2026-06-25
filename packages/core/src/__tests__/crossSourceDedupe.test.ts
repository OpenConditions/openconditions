import { describe, it, expect } from "vitest";
import type { Geometry } from "geojson";
import type { Observation } from "../model.js";
import { dedupeAcrossSources } from "../crossSourceDedupe.js";

/** Build an event Observation. `roads` may be string[] or RoadRef-like objects. */
function evt(
  o: Partial<Observation> & {
    id: string;
    source: string;
    geometry: Geometry;
    type?: string;
    roads?: unknown;
  }
): Observation {
  const { type = "accident", roads, ...rest } = o;
  return {
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    status: "active",
    dataUpdatedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
    isStale: false,
    origin: { kind: "feed", attribution: { provider: o.source, license: "CC0-1.0" } },
    // ConditionEvent-shaped fields carried structurally (cast below).
    type,
    category: "incident",
    severity: "high",
    severitySource: "derived",
    headline: "",
    ...(roads !== undefined ? { roads } : {}),
    ...rest,
  } as unknown as Observation;
}

const pt = (lng: number, lat: number): Geometry => ({ type: "Point", coordinates: [lng, lat] });
// ~Δlat in degrees for a given metre offset at these latitudes (1° lat ≈ 111_320 m).
const dLat = (m: number) => m / 111_320;

describe("dedupeAcrossSources", () => {
  it("returns [] for empty input", () => {
    expect(dedupeAcrossSources([])).toEqual([]);
  });

  it("merges the same incident reported by two sources (point vs overlapping line, shared road ref)", () => {
    const autobahn = evt({
      id: "autobahn:1",
      source: "autobahn-de",
      type: "accident",
      roads: [{ ref: "A3" }],
      geometry: pt(8.0, 50.0),
      dataUpdatedAt: "2026-01-01T10:00:00Z",
    });
    const nrw = evt({
      id: "nrw:9",
      source: "nrw-viz",
      type: "accident",
      roads: [{ name: "A3 Köln-Frankfurt" }],
      geometry: {
        type: "LineString",
        coordinates: [
          [8.0, 49.999],
          [8.0, 50.001],
        ],
      },
      dataUpdatedAt: "2026-01-01T11:00:00Z",
    });

    const out = dedupeAcrossSources([autobahn, nrw]);
    expect(out).toHaveLength(1);
    // The richer geometry (the line) wins as the representative.
    expect(out[0]!.id).toBe("nrw:9");
    // The other source is preserved, not dropped.
    expect(out[0]!.mergedSources).toEqual([
      {
        source: "autobahn-de",
        id: "autobahn:1",
        attribution: { provider: "autobahn-de", license: "CC0-1.0" },
      },
    ]);
    expect(out[0]!.origin.attribution.provider).toBe("nrw-viz");
  });

  it("never merges events that name different roads (interchange), even co-located + same type", () => {
    const a = evt({ id: "a:1", source: "src-a", roads: [{ ref: "A3" }], geometry: pt(8.0, 50.0) });
    const b = evt({ id: "b:1", source: "src-b", roads: [{ ref: "A4" }], geometry: pt(8.0, 50.0) });
    expect(dedupeAcrossSources([a, b])).toHaveLength(2);
  });

  it("never merges two events from the SAME source (left to the in-parser dedup)", () => {
    const a = evt({ id: "a:1", source: "src-a", roads: [{ ref: "A3" }], geometry: pt(8.0, 50.0) });
    const b = evt({ id: "a:2", source: "src-a", roads: [{ ref: "A3" }], geometry: pt(8.0, 50.0) });
    expect(dedupeAcrossSources([a, b])).toHaveLength(2);
  });

  it("never merges events of different types", () => {
    const a = evt({
      id: "a:1",
      source: "src-a",
      type: "accident",
      roads: [{ ref: "A3" }],
      geometry: pt(8.0, 50.0),
    });
    const b = evt({
      id: "b:1",
      source: "src-b",
      type: "roadworks",
      roads: [{ ref: "A3" }],
      geometry: pt(8.0, 50.0),
    });
    expect(dedupeAcrossSources([a, b])).toHaveLength(2);
  });

  it("passes measurements through untouched (never dedups flow readings)", () => {
    const m = (id: string, source: string): Observation =>
      ({
        id,
        source,
        sourceFormat: "datex2",
        domain: "roads",
        kind: "measurement",
        status: "active",
        geometry: pt(8.0, 50.0),
        metric: "flow",
        aggregation: "live",
        dataUpdatedAt: "2026-01-01T00:00:00Z",
        fetchedAt: "2026-01-01T00:00:00Z",
        isStale: false,
        origin: { kind: "feed", attribution: { provider: source, license: "CC0-1.0" } },
      }) as unknown as Observation;
    expect(dedupeAcrossSources([m("a:1", "src-a"), m("b:1", "src-b")])).toHaveLength(2);
  });

  it("merges co-located ref-less events within the tight radius, keeps them apart beyond it", () => {
    const near = [
      evt({ id: "a", source: "src-a", geometry: pt(8.0, 50.0) }),
      evt({ id: "b", source: "src-b", geometry: pt(8.0, 50.0 + dLat(50)) }), // ~50 m
    ];
    const far = [
      evt({ id: "a", source: "src-a", geometry: pt(8.0, 50.0) }),
      evt({ id: "b", source: "src-b", geometry: pt(8.0, 50.0 + dLat(110)) }), // ~110 m > 75 m
    ];
    expect(dedupeAcrossSources(near)).toHaveLength(1);
    expect(dedupeAcrossSources(far)).toHaveLength(2);
  });

  it("a shared road ref widens the merge radius (corroborated), but not unboundedly", () => {
    const within = [
      evt({ id: "a", source: "src-a", roads: [{ ref: "A3" }], geometry: pt(8.0, 50.0) }),
      evt({
        id: "b",
        source: "src-b",
        roads: [{ ref: "A3" }],
        geometry: pt(8.0, 50.0 + dLat(190)),
      }), // ~190 m < 250
    ];
    const beyond = [
      evt({ id: "a", source: "src-a", roads: [{ ref: "A3" }], geometry: pt(8.0, 50.0) }),
      evt({
        id: "b",
        source: "src-b",
        roads: [{ ref: "A3" }],
        geometry: pt(8.0, 50.0 + dLat(340)),
      }), // ~340 m > 250
    ];
    expect(dedupeAcrossSources(within)).toHaveLength(1);
    expect(dedupeAcrossSources(beyond)).toHaveLength(2);
  });

  it("picks the richest representative even when it is older", () => {
    const sparse = evt({
      id: "sparse",
      source: "src-a",
      roads: [{ ref: "A3" }],
      geometry: pt(8.0, 50.0),
      dataUpdatedAt: "2026-01-02T00:00:00Z", // newer
    });
    const rich = evt({
      id: "rich",
      source: "src-b",
      roads: [{ ref: "A3" }],
      geometry: {
        type: "LineString",
        coordinates: [
          [8.0, 49.999],
          [8.0, 50.001],
        ],
      },
      description: "Two lanes blocked between the Frankfurt and Offenbach junctions",
      dataUpdatedAt: "2026-01-01T00:00:00Z", // older
    } as Partial<Observation> & { id: string; source: string; geometry: Geometry });
    const out = dedupeAcrossSources([sparse, rich]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("rich");
  });

  it("preserves input ordering (severity-DESC from the query) after dedup", () => {
    const e1 = evt({ id: "e1", source: "src-a", roads: [{ ref: "A3" }], geometry: pt(8.0, 50.0) });
    const e1dup = evt({
      id: "e1dup",
      source: "src-b",
      roads: [{ ref: "A3" }],
      geometry: pt(8.0, 50.0),
    });
    const e2 = evt({
      id: "e2",
      source: "src-a",
      roads: [{ ref: "A99" }],
      geometry: pt(11.5, 48.1),
    });
    // Input order [e1, e1dup, e2]; e1+e1dup merge → survivor keeps the lead slot.
    const out = dedupeAcrossSources([e1, e1dup, e2]);
    expect(out).toHaveLength(2);
    expect(out[1]!.id).toBe("e2");
  });
});
