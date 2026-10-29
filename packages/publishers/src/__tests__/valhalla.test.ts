import { spawnSync } from "node:child_process";
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

  it("bounds caller-supplied malformed evidence in the built Valhalla adapter", () => {
    const projected = segmentConditionsToJson([segmentRow({ segments: fullWay })], at, {
      resolverVersion: "2.0.0",
    });
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict";
       const { segmentConditionsToExclusions } = await import(process.argv[1]);
       const conditions = JSON.parse(process.argv[2]);
       const at = new Date(process.argv[3]);
       const project = () => segmentConditionsToExclusions(conditions, { activeAt: at, evaluatedAt: at });
       assert.ok(project().exclude_locations.length > 0);
       console.log("control passed");
       conditions[0].routing_evidence.source_checked_at = "T".repeat(100000) + "!";
       assert.deepEqual(project(), { exclude_locations: [], exclude_polygons: [], speed_caps: [] });
       console.log("checked");`,
        new URL("../../dist/index.js", import.meta.url).href,
        JSON.stringify(projected.conditions),
        at.toISOString(),
      ],
      { encoding: "utf8", timeout: 2000, maxBuffer: 4096 },
    );
    expect(child.stdout).toContain("control passed");
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("control passed\nchecked");
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

  // The same table pins the OpenMapX live-traffic writer (data-manager
  // conditions-to-edges): both must close the road for the same applicability.
  const under35t = [
    { dimension: "gross_weight", operator: "lt", value: { value: 3500, unit: "kg" } },
  ];
  it.each([
    ["every vehicle", { kind: "all" }, true],
    ["cars", { kind: "classes", include: [{ class: "car" }] }, true],
    ["motor vehicles", { kind: "classes", include: [{ class: "motor_vehicle" }] }, true],
    [
      "all but emergency services",
      { kind: "all", except: [{ usage: "emergency_services" }] },
      true,
    ],
    ["all but residents", { kind: "all", except: [{ usage: "residents" }] }, true],
    ["all but buses", { kind: "all", except: [{ class: "bus" }] }, true],
    ["all but cars", { kind: "all", except: [{ class: "car" }] }, false],
    ["all but electric vehicles", { kind: "all", except: [{ fuel: "electric" }] }, false],
    ["all but vehicles under 3.5 t", { kind: "all", except: [{ when: under35t }] }, false],
    ["cars under 3.5 t", { kind: "classes", include: [{ class: "car", when: under35t }] }, false],
    ["lorries", { kind: "classes", include: [{ class: "hgv" }] }, false],
  ])("closes the road to cars for a closure of %s", (_, applicability, closes) => {
    const effect = { ...closure, applicability } as Effect;
    const out = exclusions([segmentRow({ segments: fullWay, effect })]);
    expect(out.exclude_locations.length > 0).toBe(closes);
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
