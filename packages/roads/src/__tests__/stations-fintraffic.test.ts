import { describe, expect, it } from "vitest";
import { parseFintrafficStations } from "../stations-fintraffic.js";

const geojson = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: 23001,
      properties: { tmsNumber: 1 },
      geometry: { type: "Point", coordinates: [24.9, 60.2] },
    },
    {
      type: "Feature",
      properties: { id: 23002 },
      geometry: { type: "Point", coordinates: [25.1, 60.3] },
    },
    { type: "Feature", id: 23003, properties: {}, geometry: null },
  ],
});

describe("parseFintrafficStations", () => {
  it("maps station id → Point geometry", () => {
    const map = parseFintrafficStations(geojson);
    expect(map.get("23001")).toEqual({ type: "Point", coordinates: [24.9, 60.2] });
    expect(map.get("23002")).toEqual({ type: "Point", coordinates: [25.1, 60.3] });
    expect(map.has("23003")).toBe(false);
  });

  it("returns an empty map on malformed input", () => {
    expect(parseFintrafficStations("x").size).toBe(0);
  });
});
