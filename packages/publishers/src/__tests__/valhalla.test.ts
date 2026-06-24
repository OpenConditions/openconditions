import { describe, expect, it } from "vitest";
import { eventsToExclusions } from "../valhalla.js";
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

  it("maps a Polygon to an exterior ring of [lon, lat] pairs (GeoJSON order)", () => {
    const ring: [number, number][] = [
      [4.0, 52.0],
      [4.1, 52.0],
      [4.1, 52.1],
      [4.0, 52.0],
    ];
    const ex = eventsToExclusions([
      roadEvent({ severity: "critical", geometry: { type: "Polygon", coordinates: [ring] } }),
    ]);
    expect(ex.exclude_polygons).toEqual([ring]);
    expect(ex.exclude_locations).toEqual([]);
  });

  it("includes any active critical event, not just typed closures", () => {
    const ex = eventsToExclusions([roadEvent({ type: "accident", severity: "critical" })]);
    expect(ex.exclude_locations).toHaveLength(1);
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
});
