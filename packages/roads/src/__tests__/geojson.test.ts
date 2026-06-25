import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FEED_SOURCES, feedToSourceDescriptor } from "../feeds.js";
import { parseGeoJson } from "../geojson.js";
import type { SourceDescriptor } from "../types.js";

const SRC: SourceDescriptor = {
  id: "test-gj",
  attribution: "Test GeoJSON",
  country: "AU",
  license: "CC-BY-4.0",
  geojson: {
    idField: "id",
    typeField: "category",
    headlineField: "headline",
    descriptionField: "info",
    severityField: "priority",
    severityMap: { high: "high", low: "low" },
    roadField: "road",
    updatedField: "updated",
  },
};

function fc(features: unknown[]): string {
  return JSON.stringify({ type: "FeatureCollection", features });
}

describe("parseGeoJson", () => {
  it("maps a feature through the field mapping + taxonomy crosswalk", () => {
    const out = parseGeoJson(
      fc([
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [151.2, -33.8] },
          properties: {
            id: "X1",
            category: "Crash",
            headline: "Crash on M1",
            info: "Two vehicles",
            priority: "high",
            road: "M1",
            updated: "2026-06-25T10:00:00Z",
          },
        },
      ]),
      SRC
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "test-gj:X1",
      source: "test-gj",
      sourceFormat: "geojson",
      type: "accident", // "Crash"→incident via crosswalk
      severity: "high",
      headline: "Crash on M1",
      description: "Two vehicles",
      dataUpdatedAt: "2026-06-25T10:00:00Z",
    });
    expect(out[0]!.geometry).toEqual({ type: "Point", coordinates: [151.2, -33.8] });
    expect(out[0]!.roads).toEqual([{ name: "M1" }]);
    // Lossless passthrough.
    expect((out[0]!.sourceRaw as { id: string }).id).toBe("X1");
  });

  it("uses defaultType for feeds without a per-feature type (e.g. closures-only)", () => {
    const out = parseGeoJson(
      fc([
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
          properties: { id: "c1" },
        },
      ]),
      { ...SRC, geojson: { idField: "id", defaultType: "road_closure" } }
    );
    expect(out[0]!.type).toBe("road_closure");
    expect(out[0]!.category).toBe("incident");
  });

  it("skips features with null/absent geometry", () => {
    const out = parseGeoJson(
      fc([
        { type: "Feature", geometry: null, properties: { id: "n" } },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { id: "y", category: "roadworks" },
        },
      ]),
      SRC
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("test-gj:y");
  });

  it("falls back to the feature index when no id field is present", () => {
    const out = parseGeoJson(
      fc([{ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: {} }]),
      { ...SRC, geojson: { typeField: "category" } }
    );
    expect(out[0]!.id).toBe("test-gj:0");
    expect(out[0]!.type).toBe("other");
  });

  it("accepts a GeometryCollection feature (Berlin VIZ mixes Point+LineString)", () => {
    const out = parseGeoJson(
      fc([
        {
          type: "Feature",
          geometry: {
            type: "GeometryCollection",
            geometries: [
              { type: "Point", coordinates: [13.3, 52.5] },
              {
                type: "LineString",
                coordinates: [
                  [13.3, 52.5],
                  [13.31, 52.51],
                ],
              },
            ],
          },
          properties: { id: "g1", category: "roadworks" },
        },
      ]),
      SRC
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.geometry!.type).toBe("GeometryCollection");
    expect(out[0]!.type).toBe("roadworks");
  });

  it("reprojects EPSG:3857 (Web Mercator) coordinates to WGS84", () => {
    const out = parseGeoJson(
      JSON.stringify({
        type: "FeatureCollection",
        crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3857" } },
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-8338879.6, 5772014.3] },
            properties: { id: "m1", category: "roadworks" },
          },
        ],
      }),
      SRC
    );
    const g = out[0]!.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    // ~Québec: lon ≈ -74.9, lat ≈ 45.9 (not the raw metre values).
    expect(g.coordinates[0]!).toBeGreaterThan(-80);
    expect(g.coordinates[0]!).toBeLessThan(-70);
    expect(g.coordinates[1]!).toBeGreaterThan(44);
    expect(g.coordinates[1]!).toBeLessThan(48);
  });

  it("builds Point geometry from lonField/latField when set (national-grid geometry)", () => {
    const out = parseGeoJson(
      JSON.stringify({
        type: "FeatureCollection",
        crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3057" } },
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [335406, 508994] }, // EPSG:3057 metres
            properties: { kind: "roadworks", X: -22.49, Y: 65.04 },
          },
        ],
      }),
      { ...SRC, geojson: { lonField: "X", latField: "Y", typeField: "kind" } }
    );
    // Uses the WGS84 X/Y, not the raw 3057 geometry.
    expect(out[0]!.geometry).toEqual({ type: "Point", coordinates: [-22.49, 65.04] });
  });

  it("returns [] for malformed JSON or a non-FeatureCollection", () => {
    expect(parseGeoJson("not json", SRC)).toEqual([]);
    expect(parseGeoJson(JSON.stringify({ type: "Feature" }), SRC)).toEqual([]);
  });

  it("accepts a Buffer and reads a dotted properties path", () => {
    const buf = Buffer.from(
      fc([
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { meta: { kind: "roadworks" } },
        },
      ]),
      "utf8"
    );
    const out = parseGeoJson(buf, { ...SRC, geojson: { typeField: "meta.kind" } });
    expect(out[0]!.type).toBe("roadworks");
  });
});

describe("parseGeoJson — NZTA Road Events fixture (real wired mapping)", () => {
  it("parses the live ArcGIS GeoJSON via the registered nzta-nz mapping", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "nzta-nz")!;
    const xml = readFileSync(join(import.meta.dirname, "fixtures/nzta-nz/road-events.geojson"));
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.geometry != null)).toBe(true);
    // WGS84 NZ coordinates (lon ~166..179, lat ~ -47..-34).
    const pt = events.find((e) => e.geometry?.type === "Point")!;
    const g = pt.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    expect(g.coordinates[0]!).toBeGreaterThan(160);
    expect(g.coordinates[1]!).toBeLessThan(-30);
    // The source vocabulary maps through the per-feed typeMap (no raw "Crash" leak).
    expect(events.every((e) => e.type !== ("Crash" as unknown))).toBe(true);
    expect(events[0]!.sourceFormat).toBe("geojson");
  });
});

describe("parseGeoJson — Berlin VIZ fixture (GeometryCollection + German vocab)", () => {
  it("parses mixed GeometryCollection/Point features via the registered berlin-de mapping", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "berlin-de")!;
    const xml = readFileSync(join(import.meta.dirname, "fixtures/berlin-de/baustellen.geojson"));
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.geometry != null)).toBe(true);
    // German subtype vocab maps via the per-feed typeMap (not all "other").
    expect(events.some((e) => e.type === "roadworks" || e.type === "road_closure")).toBe(true);
    // At least one GeometryCollection survived (the bug fix).
    expect(events.some((e) => e.geometry?.type === "GeometryCollection")).toBe(true);
  });
});

describe("parseGeoJson — MTQ Québec fixture (EPSG:3857 reprojection)", () => {
  it("reprojects the WFS Web-Mercator output to WGS84 via the registered mtq-qc mapping", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "mtq-qc")!;
    const xml = readFileSync(join(import.meta.dirname, "fixtures/mtq-qc/chantiers.geojson"));
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === "roadworks")).toBe(true);
    // Coordinates land in Québec lon/lat, not raw 3857 metres.
    const ls = events.find((e) => e.geometry?.type === "LineString")!;
    const g = ls.geometry;
    if (!g || g.type !== "LineString") throw new Error("expected LineString");
    const [lon, lat] = g.coordinates[0]!;
    expect(lon!).toBeGreaterThan(-80);
    expect(lon!).toBeLessThan(-57);
    expect(lat!).toBeGreaterThan(44);
    expect(lat!).toBeLessThan(63);
  });
});

describe("parseGeoJson — Vegagerðin Iceland fixture (lon/lat from properties)", () => {
  it("uses the WGS84 X/Y fields, not the EPSG:3057 geometry, via the registered mapping", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "vegagerdin-is")!;
    const xml = readFileSync(
      join(import.meta.dirname, "fixtures/vegagerdin-is/pointincident.geojson")
    );
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    expect(events.length).toBeGreaterThan(0);
    const g = events[0]!.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    // Iceland WGS84 bounds (lon ~ -25..-13, lat ~ 63..67), not 3057 metres.
    expect(g.coordinates[0]!).toBeGreaterThan(-25);
    expect(g.coordinates[0]!).toBeLessThan(-13);
    expect(g.coordinates[1]!).toBeGreaterThan(63);
    expect(g.coordinates[1]!).toBeLessThan(67);
  });
});
