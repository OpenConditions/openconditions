import { describe, expect, it } from "vitest";
import { capCircle, capPolygon, capReferences } from "../cap.js";

describe("CAP encodings", () => {
  it("reads references and skips an entry that is not a triple", () => {
    expect(
      capReferences(
        "w-nws.webmaster@noaa.gov,urn:oid:2.49.0.1.840.0.93490f.001.1,2026-09-30T18:14:00-05:00 broken",
      ),
    ).toEqual([
      {
        sender: "w-nws.webmaster@noaa.gov",
        identifier: "urn:oid:2.49.0.1.840.0.93490f.001.1",
        sent: "2026-09-30T18:14:00-05:00",
      },
    ]);
  });

  it("turns lat,lon pairs into a GeoJSON ring and refuses an open one", () => {
    expect(capPolygon("39.22,-98.04 38.91,-98.51 38.98,-98.66 39.22,-98.04")).toEqual([
      [
        [-98.04, 39.22],
        [-98.51, 38.91],
        [-98.66, 38.98],
        [-98.04, 39.22],
      ],
    ]);
    expect(capPolygon("39.22,-98.04 38.91,-98.51 38.98,-98.66 39.2,-98.04")).toBeNull();
    // Written lon,lat by mistake: a latitude beyond 90 is no coordinate.
    expect(capPolygon("-98.04,39.22 -98.51,38.91 -98.66,38.98 -98.04,39.22")).toBeNull();
  });

  it("splits a polygon across the antimeridian into two rings that stay on the globe", () => {
    const aleutians = capPolygon("51,179 51,-179 52,-179 52,179 51,179");
    expect(aleutians).toHaveLength(2);
    const [west, east] = aleutians as [[number, number][], [number, number][]];
    expect(west.every(([x]) => x >= 179 && x <= 180)).toBe(true);
    expect(east.every(([x]) => x >= -180 && x <= -179)).toBe(true);
    for (const ring of [west, east]) expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it("approximates a circle by a closed ring at its radius, and a zero radius by its centre", () => {
    const circle = capCircle("48.0,11.0 10");
    expect(circle?.type).toBe("Polygon");
    const ring = (circle as { coordinates: [number, number][][] }).coordinates[0]!;
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring[32]);
    const north = ring[0]!;
    expect(north[0]).toBeCloseTo(11.0, 6);
    expect((north[1] - 48.0) * 111.195).toBeCloseTo(10, 2);
    expect(capCircle("48.0,11.0 0")).toEqual({ type: "Point", coordinates: [11.0, 48.0] });
    expect(capCircle("48.0 10")).toBeNull();
  });

  it("splits a circle across the antimeridian into two polygons that stay on the globe", () => {
    const fiji = capCircle("-17.8,179.95 50");
    expect(fiji?.type).toBe("MultiPolygon");
    const [west, east] = (fiji as { coordinates: [number, number][][][] }).coordinates as [
      [number, number][][],
      [number, number][][],
    ];
    const lons = (p: [number, number][][]) => p[0]!.map(([x]) => x);
    expect(Math.min(...lons(west))).toBeGreaterThan(179);
    expect(Math.max(...lons(west))).toBe(180);
    expect(Math.min(...lons(east))).toBe(-180);
    expect(Math.max(...lons(east))).toBeLessThan(-179);
    for (const ring of [west[0]!, east[0]!]) expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(capCircle("-17.8,-179.95 50")?.type).toBe("MultiPolygon");
  });
});
