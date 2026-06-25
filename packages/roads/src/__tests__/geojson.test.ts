import { describe, expect, it } from "vitest";
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
