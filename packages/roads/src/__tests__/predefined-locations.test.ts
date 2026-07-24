import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePredefinedLocations } from "../predefined-locations.js";

describe("parsePredefinedLocations", () => {
  const xml = readFileSync(join(import.meta.dirname, "fixtures/autobahn-bab/verortung.xml"));
  const map = parsePredefinedLocations(xml);

  it("resolves a point predefinedLocation to a WGS84 Point", () => {
    expect(map.get("MQ_A1_0042")).toEqual({ type: "Point", coordinates: [10.0574, 53.60864] });
  });

  it("resolves a linear predefinedLocation to a LineString", () => {
    expect(map.get("MQ_A7_0100")).toEqual({
      type: "LineString",
      coordinates: [
        [9.9822, 53.5488],
        [10.0009, 53.5677],
      ],
    });
  });

  it("returns a map sized to the resolvable records only", () => {
    expect(map.size).toBe(2);
  });
});
