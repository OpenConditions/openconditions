import { describe, expect, it } from "vitest";
import { OBSERVED_PROPERTIES } from "@openconditions/core";
import { ROAD_EVENT_TYPES, roadAttributes, roadFlowAttributes } from "../model.js";
import type { RoadEvent, RoadFlow } from "../model.js";

/**
 * Drift guard: this test lives in @openconditions/roads (which may import both
 * packages) because core cannot import roads. It asserts the core registry stays
 * in lockstep with the roads taxonomy and attribute mappers — the single reason
 * the registry can list road specifics without a dependency cycle.
 */
describe("ObservedProperty registry ↔ roads taxonomy", () => {
  it("registers a roads/<type> entry for every ROAD_EVENT_TYPES member", () => {
    for (const type of ROAD_EVENT_TYPES) {
      expect(OBSERVED_PROPERTIES[`roads/${type}`], `roads/${type}`).toBeDefined();
    }
  });

  it("does not register a roads/<event> type outside ROAD_EVENT_TYPES", () => {
    const known = new Set<string>(ROAD_EVENT_TYPES);
    // roads/flow and roads/temperature are measurements, not event types.
    const measurementKeys = new Set(["roads/flow", "roads/temperature"]);
    for (const key of Object.keys(OBSERVED_PROPERTIES)) {
      if (!key.startsWith("roads/") || measurementKeys.has(key)) continue;
      expect(known.has(key.slice("roads/".length)), key).toBe(true);
    }
  });

  it("matches roads/flow expectedAttributeKeys to the roadFlowAttributes mapper output", () => {
    const flow: RoadFlow = {
      id: "s:1",
      source: "s",
      sourceFormat: "native",
      domain: "roads",
      kind: "measurement",
      metric: "flow",
      aggregation: "live",
      geometry: { type: "Point", coordinates: [4, 52] },
      status: "active",
      origin: { kind: "feed", attribution: { provider: "P", license: "CC0-1.0" } },
      dataUpdatedAt: "2026-07-01T10:00:00Z",
      fetchedAt: "2026-07-01T10:00:00Z",
      isStale: false,
      los: "heavy",
      speedKph: 40,
      freeFlowKph: 100,
      freeFlowSource: "native",
      direction: "N",
      speedRatio: 0.4,
      delaySeconds: 30,
      jamFactor: 5,
    };
    const produced = Object.keys(roadFlowAttributes(flow)).sort();
    const registered = [...(OBSERVED_PROPERTIES["roads/flow"]?.expectedAttributeKeys ?? [])].sort();
    expect(registered).toEqual(produced);
  });

  it("matches roads/<event> expectedAttributeKeys to the roadAttributes mapper output", () => {
    const event: RoadEvent = {
      id: "s:1",
      source: "s",
      sourceFormat: "geojson",
      domain: "roads",
      kind: "event",
      type: "roadworks",
      category: "planned",
      severity: "low",
      severitySource: "declared",
      headline: "H",
      status: "active",
      geometry: { type: "Point", coordinates: [4, 52] },
      origin: { kind: "feed", attribution: { provider: "P", license: "CC0-1.0" } },
      dataUpdatedAt: "2026-07-01T10:00:00Z",
      fetchedAt: "2026-07-01T10:00:00Z",
      isStale: false,
      isPlanned: true,
      roads: [{ name: "A1" }],
      direction: "N",
      roadState: "some_lanes_closed",
      lanesAffected: { total: 3, closed: 1 },
      speedLimitKph: 50,
      restrictions: [{ type: "width", value: 3, unit: "m" }],
      vehiclesAffected: ["truck"],
      detour: "via B12",
      detourGeometry: {
        type: "LineString",
        coordinates: [
          [4, 52],
          [4.1, 52.1],
        ],
      },
      delaySeconds: 120,
      queueLengthMeters: 500,
      workersPresent: true,
      workZoneType: "static",
      regions: ["Utrecht"],
      relatedEvents: [{ id: "x" }],
      externalRefs: { openlr: "abc" },
      sourceRaw: { foo: "bar" },
      freeFlowSource: "native",
    };
    const produced = Object.keys(roadAttributes(event)).sort();
    const registered = [
      ...(OBSERVED_PROPERTIES["roads/roadworks"]?.expectedAttributeKeys ?? []),
    ].sort();
    expect(registered).toEqual(produced);
  });
});
