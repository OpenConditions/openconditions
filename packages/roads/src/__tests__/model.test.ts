import { describe, expect, it } from "vitest";
import { isRoadEventType, ROAD_EVENT_TYPES, type RoadEventType } from "../model.js";

describe("ROAD_EVENT_TYPES", () => {
  it("is a non-empty, duplicate-free canonical list", () => {
    expect(ROAD_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(new Set(ROAD_EVENT_TYPES).size).toBe(ROAD_EVENT_TYPES.length);
  });

  it("includes the 'other' fallback type", () => {
    expect(ROAD_EVENT_TYPES).toContain("other");
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
