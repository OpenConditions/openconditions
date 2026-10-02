import type { SegmentConditionRow } from "@openconditions/core";
import type { Effect } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { segmentConditionsToJson } from "../segment-conditions.js";
import { flowToSegmentSpeedCsv, segmentConditionsToExclusions } from "../valhalla.js";
import { closure, segmentRow } from "./segment-rows.js";

const at = new Date("2026-09-06T10:00:00Z");
const line = {
  type: "LineString" as const,
  coordinates: [
    [6.8, 51.2],
    [6.801, 51.2],
  ],
};
/** Both directions of way 10, end to end. */
const fullWay = [
  {
    segmentId: "10:f",
    wayId: 10,
    dir: "f" as const,
    startFraction: 0,
    endFraction: 1,
    geometry: line,
  },
  {
    segmentId: "10:b",
    wayId: 10,
    dir: "b" as const,
    startFraction: 0,
    endFraction: 1,
    geometry: line,
  },
];

function exclusions(rows: SegmentConditionRow[]) {
  const projected = segmentConditionsToJson(rows, at, { resolverVersion: "2.0.0" });
  return segmentConditionsToExclusions(projected.conditions, { activeAt: at, evaluatedAt: at });
}

describe("segmentConditionsToExclusions", () => {
  it("excludes a bidirectional, full-way closure that applies to cars", () => {
    expect(
      exclusions([segmentRow({ segments: fullWay })]).exclude_locations.length,
    ).toBeGreaterThan(0);
    const cars = { ...closure, applicability: { kind: "classes", include: [{ class: "car" }] } };
    expect(
      exclusions([segmentRow({ segments: fullWay, effect: cars as Effect })]).exclude_locations
        .length,
    ).toBeGreaterThan(0);
  });

  it("does not exclude a closure narrower than every car, in one direction or part of a way", () => {
    const trucks = {
      ...closure,
      applicability: { kind: "classes", include: [{ class: "truck" }] },
    };
    const exceptCars = { ...closure, applicability: { kind: "all", except: [{ class: "car" }] } };
    const none = { exclude_locations: [], exclude_polygons: [], speed_caps: [] };
    expect(exclusions([segmentRow({ segments: fullWay, effect: trucks as Effect })])).toEqual(none);
    expect(exclusions([segmentRow({ segments: fullWay, effect: exceptCars as Effect })])).toEqual(
      none,
    );
    expect(exclusions([segmentRow()])).toEqual(none);
  });

  it("excludes every lane closed as a closure, and no closure off the carriageway", () => {
    const allLanes = {
      ...closure,
      kind: "lane_restriction",
      vehicleImpact: "all_lanes_closed",
    } as unknown as Effect;
    expect(
      exclusions([segmentRow({ segments: fullWay, effect: allLanes })]).exclude_locations.length,
    ).toBeGreaterThan(0);
    const someLanes = { ...allLanes, vehicleImpact: "some_lanes_closed" } as unknown as Effect;
    const cycleway = { ...closure, scope: "cycleway" } as Effect;
    const none = { exclude_locations: [], exclude_polygons: [], speed_caps: [] };
    expect(exclusions([segmentRow({ segments: fullWay, effect: someLanes })])).toEqual(none);
    expect(exclusions([segmentRow({ segments: fullWay, effect: cycleway })])).toEqual(none);
  });

  it("never excludes restriction evidence", () => {
    const unknown = { ...closure, applicability: { kind: "unknown" } } as Effect;
    expect(exclusions([segmentRow({ segments: fullWay, effect: unknown })])).toEqual({
      exclude_locations: [],
      exclude_polygons: [],
      speed_caps: [],
    });
  });

  it("caps the speed of each span a mandatory speed limit for cars covers", () => {
    const limit = {
      id: "a1/speed_limit",
      kind: "speed_limit",
      v: 1,
      limit: { value: 60, unit: "km/h" },
      applicability: { kind: "all" },
      compliance: "mandatory",
      normalization: "complete",
    } as Effect;
    const advisory = { ...limit, id: "a1/advisory", advisory: true } as Effect;
    const out = exclusions([
      segmentRow({ effect_id: "a1/speed_limit", effect: limit }),
      segmentRow({ effect_id: "a1/advisory", effect: advisory }),
    ]);
    expect(out.speed_caps).toEqual([
      { way_id: 10, dir: "f", start_fraction: 0.3, end_fraction: 1, limit_kph: 60 },
    ]);
    expect(out.exclude_locations).toEqual([]);
  });
});

describe("flowToSegmentSpeedCsv", () => {
  it("emits just the header for no rows", () => {
    expect(flowToSegmentSpeedCsv([])).toBe("way_id,dir,current_kph,free_flow_kph,los");
  });

  it("formats a measured row after the header", () => {
    const csv = flowToSegmentSpeedCsv([
      { wayId: 500, dir: "f", currentKph: 50, freeFlowKph: 100, los: "heavy" },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("way_id,dir,current_kph,free_flow_kph,los");
    expect(lines[1]).toBe("500,f,50,100,heavy");
  });

  it("renders null current/free-flow as an empty field, not the string null", () => {
    const csv = flowToSegmentSpeedCsv([
      { wayId: 501, dir: "b", currentKph: null, freeFlowKph: null, los: "unknown" },
    ]);
    expect(csv.split("\n")[1]).toBe("501,b,,,unknown");
  });
});
