import { describe, expect, it } from "vitest";
import { segmentsToGeoJSON } from "../segments.js";

describe("segmentsToGeoJSON", () => {
  it("projects a segment-speed row into a Feature with parsed geometry + attribute properties", () => {
    const fc = segmentsToGeoJSON([
      {
        segmentId: "1:f",
        dir: "f",
        highway: "motorway",
        geojson: '{"type":"LineString","coordinates":[[5,52],[5.1,52.1]]}',
        speedRatio: 0.5,
        los: "heavy",
        confidence: "measured",
        observedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0] as { geometry: unknown; properties: Record<string, unknown> };
    expect(f.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [5, 52],
        [5.1, 52.1],
      ],
    });
    expect(f.properties).toEqual({
      segment_id: "1:f",
      dir: "f",
      highway: "motorway",
      speed_ratio: 0.5,
      los: "heavy",
      confidence: "measured",
      observed_at: "2026-07-01T00:00:00.000Z",
    });
  });

  it("omits ref and speed properties entirely when undefined (a base segment with no fused speed)", () => {
    const fc = segmentsToGeoJSON([
      {
        segmentId: "2:b",
        dir: "b",
        highway: "primary",
        geojson: '{"type":"LineString","coordinates":[[6,53],[6.1,53.1]]}',
      },
    ]);
    const f = fc.features[0] as { properties: Record<string, unknown> };
    expect(f.properties).toEqual({ segment_id: "2:b", dir: "b", highway: "primary" });
    expect("ref" in f.properties).toBe(false);
    expect("speed_ratio" in f.properties).toBe(false);
    expect("los" in f.properties).toBe(false);
    expect("confidence" in f.properties).toBe(false);
    expect("current_kph" in f.properties).toBe(false);
    expect("free_flow_kph" in f.properties).toBe(false);
    expect("observed_at" in f.properties).toBe(false);
  });

  it("omits explicit-null speed props (a real LEFT-JOIN miss from the driver, not undefined)", () => {
    const fc = segmentsToGeoJSON([
      {
        segmentId: "4:f",
        dir: "f",
        highway: "secondary",
        geojson: '{"type":"LineString","coordinates":[[8,49],[8.1,49.1]]}',
        ref: null,
        speedRatio: null,
        los: null,
        confidence: null,
        currentKph: null,
        freeFlowKph: null,
        observedAt: null,
      },
    ]);
    const f = fc.features[0] as { properties: Record<string, unknown> };
    // A `!== undefined` guard would let these through as `null`; they must be
    // absent keys, not present-as-null.
    expect(f.properties).toEqual({ segment_id: "4:f", dir: "f", highway: "secondary" });
    for (const k of [
      "ref",
      "speed_ratio",
      "los",
      "confidence",
      "current_kph",
      "free_flow_kph",
      "observed_at",
    ]) {
      expect(k in f.properties).toBe(false);
    }
  });

  it("includes ref and current/free-flow kph when present", () => {
    const fc = segmentsToGeoJSON([
      {
        segmentId: "3:f",
        dir: "f",
        highway: "motorway",
        ref: "A2",
        geojson: '{"type":"LineString","coordinates":[[7,50],[7.1,50.1]]}',
        currentKph: 80,
        freeFlowKph: 120,
        observedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const f = fc.features[0] as { properties: Record<string, unknown> };
    expect(f.properties["ref"]).toBe("A2");
    expect(f.properties["current_kph"]).toBe(80);
    expect(f.properties["free_flow_kph"]).toBe(120);
    expect(f.properties["observed_at"]).toBe("2026-07-01T00:00:00.000Z");
  });

  it("maps multiple rows to one Feature each, in order", () => {
    const fc = segmentsToGeoJSON([
      {
        segmentId: "1:f",
        dir: "f",
        highway: "motorway",
        geojson: '{"type":"LineString","coordinates":[[5,52],[5.1,52.1]]}',
      },
      {
        segmentId: "1:b",
        dir: "b",
        highway: "motorway",
        geojson: '{"type":"LineString","coordinates":[[5.1,52.1],[5,52]]}',
      },
    ]);
    expect(fc.features).toHaveLength(2);
    expect(
      (fc.features as { properties: Record<string, unknown> }[]).map((f) => f.properties["dir"])
    ).toEqual(["f", "b"]);
  });
});
