import { describe, expect, it } from "vitest";
import { eventsToExclusions, flowToSegmentSpeedCsv } from "../valhalla.js";
import { measurement, roadEvent } from "./fixture.js";

describe("eventsToExclusions", () => {
  it("returns empty arrays for no input", () => {
    expect(eventsToExclusions([])).toEqual({ exclude_locations: [], exclude_polygons: [] });
  });

  it("maps a Point road_closure to one exclude_locations entry ({lon, lat})", () => {
    const ex = eventsToExclusions([
      roadEvent({ type: "road_closure", geometry: { type: "Point", coordinates: [4.9, 52.37] } }),
    ]);
    expect(ex.exclude_locations).toEqual([{ lon: 4.9, lat: 52.37 }]);
    expect(ex.exclude_polygons).toEqual([]);
  });

  it("samples a LineString closure into points <=45 m apart, keeping the endpoints", () => {
    // ~1.35 km segment at lat 52.5 → many sampled points, not just the 2 vertices.
    const ex = eventsToExclusions([
      roadEvent({
        type: "road_closure",
        geometry: {
          type: "LineString",
          coordinates: [
            [13.4, 52.5],
            [13.42, 52.5],
          ],
        },
      }),
    ]);
    expect(ex.exclude_locations.length).toBeGreaterThan(10);
    expect(ex.exclude_locations[0]).toEqual({ lon: 13.4, lat: 52.5 });
    expect(ex.exclude_locations.at(-1)).toEqual({ lon: 13.42, lat: 52.5 });
    // Every consecutive pair is within the spacing budget (+ small slack).
    for (let i = 1; i < ex.exclude_locations.length; i++) {
      const a = ex.exclude_locations[i - 1]!;
      const b = ex.exclude_locations[i]!;
      const dLat = (b.lat - a.lat) * 111_320;
      const dLon = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
      expect(Math.hypot(dLat, dLon)).toBeLessThanOrEqual(50);
    }
  });

  it("honours a larger maxSpacingMeters (fewer sampled points)", () => {
    const line = roadEvent({
      type: "road_closure",
      geometry: {
        type: "LineString",
        coordinates: [
          [13.4, 52.5],
          [13.42, 52.5],
        ],
      },
    });
    const tight = eventsToExclusions([line], { maxSpacingMeters: 45 });
    const loose = eventsToExclusions([line], { maxSpacingMeters: 500 });
    expect(loose.exclude_locations.length).toBeLessThan(tight.exclude_locations.length);
  });

  it("downsamples a long line to maxPointsPerClosure but keeps both endpoints", () => {
    const ex = eventsToExclusions(
      [
        roadEvent({
          type: "road_closure",
          geometry: {
            type: "LineString",
            coordinates: [
              [13.4, 52.5],
              [13.6, 52.5], // ~13.5 km → hundreds of 45 m samples, capped to 5
            ],
          },
        }),
      ],
      { maxPointsPerClosure: 5 }
    );
    expect(ex.exclude_locations).toHaveLength(5);
    expect(ex.exclude_locations[0]).toEqual({ lon: 13.4, lat: 52.5 });
    expect(ex.exclude_locations.at(-1)).toEqual({ lon: 13.6, lat: 52.5 });
  });

  it("maps a closure Polygon to an exterior ring of [lon, lat] pairs (GeoJSON order)", () => {
    const ring: [number, number][] = [
      [4.0, 52.0],
      [4.1, 52.0],
      [4.1, 52.1],
      [4.0, 52.0],
    ];
    const ex = eventsToExclusions([
      roadEvent({
        type: "road_closure",
        severity: "critical",
        geometry: { type: "Polygon", coordinates: [ring] },
      }),
    ]);
    expect(ex.exclude_polygons).toEqual([ring]);
    expect(ex.exclude_locations).toEqual([]);
  });

  it("includes any active critical event, not just typed closures", () => {
    const ex = eventsToExclusions([roadEvent({ type: "accident", severity: "critical" })]);
    expect(ex.exclude_locations).toHaveLength(1);
  });

  it("suppresses the polygon ring of a critical non-closure event (e.g. a regional weather warning)", () => {
    const ring: [number, number][] = [
      [4.0, 52.0],
      [4.1, 52.0],
      [4.1, 52.1],
      [4.0, 52.0],
    ];
    const ex = eventsToExclusions([
      roadEvent({
        type: "weather",
        severity: "critical",
        geometry: { type: "Polygon", coordinates: [ring] },
      }),
    ]);
    expect(ex.exclude_polygons).toEqual([]);
    expect(ex.exclude_locations).toEqual([]);
  });

  it("still maps a closure MultiPolygon's rings, but suppresses a critical non-closure MultiPolygon", () => {
    const ring: [number, number][] = [
      [4.0, 52.0],
      [4.1, 52.0],
      [4.1, 52.1],
      [4.0, 52.0],
    ];
    const closure = eventsToExclusions([
      roadEvent({
        type: "road_closure",
        geometry: { type: "MultiPolygon", coordinates: [[ring]] },
      }),
    ]);
    expect(closure.exclude_polygons).toEqual([ring]);

    const nonClosure = eventsToExclusions([
      roadEvent({
        type: "weather",
        severity: "critical",
        geometry: { type: "MultiPolygon", coordinates: [[ring]] },
      }),
    ]);
    expect(nonClosure.exclude_polygons).toEqual([]);
  });

  it("excludes non-closure, non-critical events", () => {
    const ex = eventsToExclusions([roadEvent({ type: "accident", severity: "high" })]);
    expect(ex).toEqual({ exclude_locations: [], exclude_polygons: [] });
  });

  it("excludes inactive/cancelled closures", () => {
    const ex = eventsToExclusions([roadEvent({ type: "road_closure", status: "cancelled" })]);
    expect(ex.exclude_locations).toEqual([]);
  });

  it("ignores measurements (only events contribute)", () => {
    const ex = eventsToExclusions([measurement()]);
    expect(ex).toEqual({ exclude_locations: [], exclude_polygons: [] });
  });

  it("caps the TOTAL exclude_locations across all closures to maxTotalPoints (default 45), evenly subsampled", () => {
    // 10 point closures, each contributing 1 location, well under 45 → unchanged.
    const few = Array.from({ length: 10 }, (_, i) =>
      roadEvent({
        id: `road_closure:${i}`,
        type: "road_closure",
        geometry: { type: "Point", coordinates: [4 + i * 0.01, 52] },
      })
    );
    expect(eventsToExclusions(few).exclude_locations).toHaveLength(10);

    // 100 point closures → raw total (100) exceeds the 45 cap, so the result
    // is subsampled down to exactly 45, preserving the first vertex.
    const many = Array.from({ length: 100 }, (_, i) =>
      roadEvent({
        id: `road_closure:${i}`,
        type: "road_closure",
        geometry: { type: "Point", coordinates: [4 + i * 0.01, 52] },
      })
    );
    const ex = eventsToExclusions(many);
    expect(ex.exclude_locations).toHaveLength(45);
    expect(ex.exclude_locations[0]).toEqual({ lon: 4, lat: 52 });
  });

  it("honours an explicit maxTotalPoints override", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      roadEvent({
        id: `road_closure:${i}`,
        type: "road_closure",
        geometry: { type: "Point", coordinates: [4 + i * 0.01, 52] },
      })
    );
    const ex = eventsToExclusions(many, { maxTotalPoints: 5 });
    expect(ex.exclude_locations).toHaveLength(5);
  });

  it("excludes a closure whose validFrom is in the future relative to activeAt", () => {
    const activeAt = new Date("2026-06-01T00:00:00Z");
    const future = roadEvent({
      type: "road_closure",
      validFrom: "2026-06-15T00:00:00Z",
      geometry: { type: "Point", coordinates: [4.9, 52.37] },
    });
    const ex = eventsToExclusions([future], { activeAt });
    expect(ex.exclude_locations).toEqual([]);
  });

  it("includes a closure whose validFrom is in the past relative to activeAt", () => {
    const activeAt = new Date("2026-06-01T00:00:00Z");
    const started = roadEvent({
      type: "road_closure",
      validFrom: "2026-05-15T00:00:00Z",
      geometry: { type: "Point", coordinates: [4.9, 52.37] },
    });
    const ex = eventsToExclusions([started], { activeAt });
    expect(ex.exclude_locations).toEqual([{ lon: 4.9, lat: 52.37 }]);
  });
});

describe("flowToSegmentSpeedCsv", () => {
  it("emits just the header for no rows", () => {
    expect(flowToSegmentSpeedCsv([])).toBe("way_id,dir,current_kph,free_flow_kph,los");
  });

  it("formats a measured row after the header", () => {
    const csv = flowToSegmentSpeedCsv([
      { wayId: 500, dir: "f", currentKph: 50, freeFlowKph: 100, los: "heavy" },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("way_id,dir,current_kph,free_flow_kph,los");
    expect(lines[1]).toBe("500,f,50,100,heavy");
  });

  it("renders null current/free-flow as an empty field, not the string null", () => {
    const csv = flowToSegmentSpeedCsv([
      { wayId: 501, dir: "b", currentKph: null, freeFlowKph: null, los: "unknown" },
    ]);
    expect(csv.split("\n")[1]).toBe("501,b,,,unknown");
  });
});
