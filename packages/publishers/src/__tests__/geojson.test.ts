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
});
