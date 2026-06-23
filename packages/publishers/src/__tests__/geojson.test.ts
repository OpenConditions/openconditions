import { describe, expect, it } from "vitest";
import { observationsToGeoJSON } from "../geojson.js";
import { measurement, roadEvent } from "./fixture.js";

describe("observationsToGeoJSON", () => {
  it("projects an event to a Feature with geometry + condition properties", () => {
    const fc = observationsToGeoJSON([
      roadEvent({ roadState: "some_lanes_closed", roads: [{ name: "A2" }] }),
    ]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0]!;
    expect(f.geometry).toEqual({ type: "Point", coordinates: [13.4, 52.5] });
    expect(f.properties).toMatchObject({
      id: "ndw:1",
      type: "accident",
      severity: "high",
      headline: "Accident on A2",
      roadState: "some_lanes_closed",
      provider: "NDW",
      license: "CC0-1.0",
    });
    expect(f.properties?.roads).toEqual([{ name: "A2" }]);
  });

  it("attaches feed_info only when provided", () => {
    expect(observationsToGeoJSON([roadEvent()]).feed_info).toBeUndefined();
    const fc = observationsToGeoJSON([roadEvent()], {
      attribution: "OpenConditions",
      license: "mixed",
    });
    expect(fc.feed_info).toEqual({ attribution: "OpenConditions", license: "mixed" });
  });

  it("projects a measurement with metric/value props", () => {
    const fc = observationsToGeoJSON([measurement()]);
    expect(fc.features[0]!.properties).toMatchObject({
      kind: "measurement",
      metric: "flow",
      value: 1200,
    });
  });

  it("carries the full typed payload in properties (RFC 7946 = arbitrary props)", () => {
    const fc = observationsToGeoJSON([
      roadEvent({
        subtype: "roadMaintenance",
        confidence: "observed",
        speedLimitKph: 50,
        lanesAffected: { total: 3, closed: 1 },
        restrictions: [{ type: "width", value: 3, unit: "m" }],
        detour: "Use A4",
        regions: ["Berlin"],
        roads: [{ name: "A2", ref: "A2", from: "X", to: "Y", milepostFrom: 10 }],
      }),
    ]);
    const p = fc.features[0]!.properties!;
    expect(p.subtype).toBe("roadMaintenance");
    expect(p.confidence).toBe("observed");
    expect(p.speedLimitKph).toBe(50);
    expect(p.lanesAffected).toEqual({ total: 3, closed: 1 });
    expect(p.restrictions).toEqual([{ type: "width", value: 3, unit: "m" }]);
    expect(p.detour).toBe("Use A4");
    expect(p.regions).toEqual(["Berlin"]);
    expect(p.roads).toEqual([{ name: "A2", ref: "A2", from: "X", to: "Y", milepostFrom: 10 }]);
    expect(p.source).toBe("ndw"); // not clobbered by sourceRaw
  });

  it("omits sourceRaw by default but includes it with includeRaw", () => {
    const ev = roadEvent({ sourceRaw: { foo: "bar" } });
    expect(observationsToGeoJSON([ev]).features[0]!.properties!.sourceRaw).toBeUndefined();
    const withRaw = observationsToGeoJSON([ev], {}, { includeRaw: true });
    expect(withRaw.features[0]!.properties!.sourceRaw).toEqual({ foo: "bar" });
  });

  it("sets a FeatureCollection bbox", () => {
    const fc = observationsToGeoJSON([
      roadEvent({ geometry: { type: "Point", coordinates: [13.4, 52.5] } }),
    ]);
    expect(fc.bbox).toEqual([13.4, 52.5, 13.4, 52.5]);
  });
});
