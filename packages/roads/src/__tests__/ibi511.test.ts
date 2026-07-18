import { describe, expect, it } from "vitest";
import { parseIbi511 } from "../ibi511.js";
import type { SourceDescriptor } from "../types.js";

const SRC: SourceDescriptor = {
  id: "ca-on-511",
  attribution: "Ontario 511",
  country: "CA",
  license: "OGL-ON",
};

describe("parseIbi511", () => {
  it("maps EventType buckets to canonical types and decodes the polyline geometry", () => {
    // "_p~iF~ps|U_ulLnnqC_mqNvxq`@" is Google's reference polyline (3 points).
    const out = parseIbi511(
      JSON.stringify([
        {
          ID: 101,
          RoadwayName: "Highway 401",
          EventType: "roadwork",
          EventSubType: "Construction",
          Description: "Lane reductions for paving",
          Severity: "Major",
          EncodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
          LastUpdated: "2026-06-25T10:00:00Z",
        },
      ]),
      SRC
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "ca-on-511:101",
      sourceFormat: "ibi511",
      type: "roadworks",
      severity: "high",
      headline: "Lane reductions for paving",
    });
    expect(out[0]!.geometry!.type).toBe("LineString");
    expect(out[0]!.roads).toEqual([{ name: "Highway 401" }]);
  });

  it("treats IsFullClosure as a road_closure regardless of EventType", () => {
    const out = parseIbi511(
      [
        {
          ID: 2,
          EventType: "accidentsAndIncidents",
          IsFullClosure: true,
          Latitude: 43.65,
          Longitude: -79.38,
        },
      ],
      SRC
    );
    expect(out[0]!.type).toBe("road_closure");
    expect(out[0]!.geometry).toEqual({ type: "Point", coordinates: [-79.38, 43.65] });
  });

  it("maps accidentsAndIncidents to accident and builds a 2-point line from secondary coords", () => {
    const out = parseIbi511(
      [
        {
          ID: 3,
          EventType: "accidentsAndIncidents",
          Latitude: 43.6,
          Longitude: -79.4,
          LatitudeSecondary: 43.61,
          LongitudeSecondary: -79.41,
        },
      ],
      SRC
    );
    expect(out[0]!.type).toBe("accident");
    expect(out[0]!.geometry!.type).toBe("LineString");
  });

  it("converts epoch-seconds dates (the real API shape) to ISO timestamps", () => {
    // The live /api/v2/get/event feed returns StartDate/PlannedEndDate/LastUpdated
    // as Unix epoch SECONDS (numbers), not ISO strings. Passing them through raw
    // crashed the on-511 batch insert ("date/time field value out of range").
    const out = parseIbi511(
      [
        {
          ID: 7,
          EventType: "roadwork",
          Latitude: 43.65,
          Longitude: -79.38,
          StartDate: 1757502000,
          PlannedEndDate: 1785538800,
          LastUpdated: 1757532060,
        },
      ],
      SRC
    );
    expect(out[0]!.validFrom).toBe("2025-09-10T11:00:00.000Z");
    expect(out[0]!.validTo).toBe(new Date(1785538800 * 1000).toISOString());
    expect(out[0]!.dataUpdatedAt).toBe(new Date(1757532060 * 1000).toISOString());
  });

  it("skips events without usable geometry and tolerates malformed input", () => {
    expect(parseIbi511([{ ID: 9, EventType: "closures" }], SRC)).toEqual([]);
    expect(parseIbi511("not json", SRC)).toEqual([]);
    expect(parseIbi511(JSON.stringify({ not: "an array" }), SRC)).toEqual([]);
  });
});
