import type { FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import { featureCollectionToRoadFlowSegments } from "../toRoadFlowSegments.js";

const fc = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [5, 52],
          [5.1, 52.1],
        ],
      },
      properties: {
        segment_id: "500:f",
        dir: "f",
        highway: "motorway",
        ref: "A2",
        speed_ratio: 0.5,
        los: "heavy",
        confidence: "measured",
        current_kph: 50,
        free_flow_kph: 100,
        observed_at: "2026-07-01T00:00:00.000Z",
      },
    },
    // A base segment with no fused speed row yet: no speed props at all.
    {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [6, 53],
          [6.1, 53.1],
        ],
      },
      properties: { segment_id: "700:f", dir: "f", highway: "primary" },
    },
    // Malformed: no segment_id -> dropped.
    {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      properties: {},
    },
    // Non-LineString geometry -> dropped.
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { segment_id: "900:f" },
    },
  ],
} as unknown as FeatureCollection;

describe("featureCollectionToRoadFlowSegments", () => {
  it("maps a fully-populated feature to a RoadFlowSegment, stamping the provider id as source", () => {
    const segments = featureCollectionToRoadFlowSegments(fc, "road-conditions-openconditions");
    const measured = segments.find((s) => s.id === "500:f")!;
    expect(measured).toMatchObject({
      id: "500:f",
      direction: "f",
      currentSpeedKph: 50,
      freeFlowSpeedKph: 100,
      speedRatio: 0.5,
      los: "heavy",
      confidence: "measured",
      roads: "A2",
      source: "road-conditions-openconditions",
      observedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(measured.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [5, 52],
        [5.1, 52.1],
      ],
    });
  });

  it("defaults a speed-less base segment to los:unknown, confidence:typical, and omits speed fields", () => {
    const segments = featureCollectionToRoadFlowSegments(fc, "road-conditions-openconditions");
    const base = segments.find((s) => s.id === "700:f")!;
    expect(base).toBeDefined();
    expect(base.los).toBe("unknown");
    expect(base.confidence).toBe("typical");
    expect(base.currentSpeedKph).toBeUndefined();
    expect(base.freeFlowSpeedKph).toBeUndefined();
    expect(base.speedRatio).toBeUndefined();
    expect(base.roads).toBeUndefined();
    expect(base.observedAt).toBeUndefined();
  });

  it("drops features with no segment_id or a non-LineString geometry", () => {
    const segments = featureCollectionToRoadFlowSegments(fc, "road-conditions-openconditions");
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.id)).toEqual(["500:f", "700:f"]);
  });

  it("falls back to los:unknown / confidence:typical for off-list upstream values", () => {
    const segments = featureCollectionToRoadFlowSegments(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [5, 52],
                [5.1, 52.1],
              ],
            },
            properties: {
              segment_id: "500:f",
              dir: "f",
              los: "gridlocked",
              confidence: "vibes",
            },
          },
        ],
      } as unknown as FeatureCollection,
      "road-conditions-openconditions"
    );
    expect(segments[0]!.los).toBe("unknown");
    expect(segments[0]!.confidence).toBe("typical");
  });

  it("maps dir:b to direction:b", () => {
    const segments = featureCollectionToRoadFlowSegments(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [5, 52],
                [5.1, 52.1],
              ],
            },
            properties: { segment_id: "500:b", dir: "b" },
          },
        ],
      },
      "road-conditions-openconditions"
    );
    expect(segments[0]!.direction).toBe("b");
  });
});
