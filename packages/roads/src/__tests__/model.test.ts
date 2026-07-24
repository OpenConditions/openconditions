import { describe, expect, it } from "vitest";
import {
  isRoadEventType,
  ROAD_EVENT_TYPES,
  roadFlowAttributes,
  type RoadEventType,
} from "../model.js";
import type { RoadFlow } from "../model.js";
import { TYPE_CROSSWALK } from "../taxonomy.js";

describe("ROAD_EVENT_TYPES", () => {
  it("is a non-empty, duplicate-free canonical list", () => {
    expect(ROAD_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(new Set(ROAD_EVENT_TYPES).size).toBe(ROAD_EVENT_TYPES.length);
  });

  it("includes the 'other' fallback type", () => {
    expect(ROAD_EVENT_TYPES).toContain("other");
  });

  it("covers every canonical type the taxonomy crosswalk maps to", () => {
    for (const mapping of Object.values(TYPE_CROSSWALK)) {
      expect(ROAD_EVENT_TYPES).toContain(mapping.type);
    }
  });
});

describe("isRoadEventType", () => {
  it("accepts every canonical type", () => {
    for (const t of ROAD_EVENT_TYPES) {
      expect(isRoadEventType(t)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isRoadEventType("not_a_type")).toBe(false);
    // canonical values are lower_snake_case; the source-format spelling is not a canonical type
    expect(isRoadEventType("Accident")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isRoadEventType(undefined)).toBe(false);
    expect(isRoadEventType(null)).toBe(false);
    expect(isRoadEventType(42)).toBe(false);
  });

  it("narrows the value to RoadEventType when it returns true", () => {
    const value: unknown = "accident";
    if (isRoadEventType(value)) {
      const narrowed: RoadEventType = value;
      expect(narrowed).toBe("accident");
    }
  });
});

const flowBase: RoadFlow = {
  id: "x:1",
  source: "x",
  sourceFormat: "datex-elaborated",
  domain: "roads",
  kind: "measurement",
  metric: "flow",
  geometry: { type: "Point", coordinates: [10, 53] },
  los: "free_flow",
  aggregation: "live",
  status: "active",
  origin: { kind: "feed", attribution: { provider: "p", license: "GeoNutzV" } },
  dataUpdatedAt: "2026-07-23T00:00:00Z",
  fetchedAt: "2026-07-23T00:00:00Z",
  isStale: false,
} as unknown as RoadFlow;

describe("roadFlowAttributes", () => {
  it("includes volume when set", () => {
    expect(roadFlowAttributes({ ...flowBase, volume: 1234 })).toMatchObject({ volume: 1234 });
  });
  it("omits volume when unset", () => {
    expect("volume" in roadFlowAttributes(flowBase)).toBe(false);
  });
});
