import type { FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import { featureCollectionToRoadConditionEvents } from "../toRoadConditionEvents.js";

// Cast through unknown: the fixture deliberately includes a malformed
// null-geometry feature to exercise the mapper's guard, which @types/geojson's
// non-null `Feature.geometry` default would otherwise reject.
const fc = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [5, 52] },
      properties: {
        id: "ndw:1",
        source: "ndw",
        type: "roadworks",
        severity: "high",
        headline: "Roadworks on A2",
        description: "Resurfacing",
        attributes: { roads: [{ name: "A2", direction: "north" }], roadState: "some_lanes_closed" },
        valid_from: "2026-06-20T00:00:00Z",
        valid_to: "2026-07-01T00:00:00Z",
        data_updated_at: "2026-06-22T05:30:00Z",
        schedule: [
          {
            repeatFrequency: "P1D",
            startDate: "2026-06-20",
            endDate: "2026-06-30",
            startTime: "20:00",
            duration: "PT9H",
            scheduleTimezone: "Europe/Amsterdam",
          },
        ],
        attribution: { provider: "NDW", license: "CC0-1.0", url: "https://www.ndw.nu" },
      },
    },
    {
      type: "Feature",
      geometry: null,
      properties: { id: "skip-me" },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { source: "x" }, // no id → dropped
    },
  ],
} as unknown as FeatureCollection;

describe("featureCollectionToRoadConditionEvents", () => {
  it("maps features and drops those without geometry or id", () => {
    const events = featureCollectionToRoadConditionEvents(fc);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "ndw:1",
      source: "ndw",
      provider: "",
      type: "roadworks",
      severity: "high",
      headline: "Roadworks on A2",
      roadState: "some_lanes_closed",
      validFrom: "2026-06-20T00:00:00Z",
      validTo: "2026-07-01T00:00:00Z",
      dataUpdatedAt: "2026-06-22T05:30:00Z",
      schedule: [
        {
          repeatFrequency: "P1D",
          startDate: "2026-06-20",
          endDate: "2026-06-30",
          startTime: "20:00",
          duration: "PT9H",
          scheduleTimezone: "Europe/Amsterdam",
        },
      ],
      geometry: { type: "Point", coordinates: [5, 52] },
    });
    expect(events[0]!.roads).toEqual([{ name: "A2", direction: "north" }]);
  });

  it("populates dataUpdatedAt from the top-level properties.data_updated_at (not attributes)", () => {
    const out = featureCollectionToRoadConditionEvents({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 1] },
          properties: {
            id: "x",
            data_updated_at: "2026-06-22T05:30:00Z",
            // A stray attrs.dataUpdatedAt must NOT be read — the real value is
            // top-level, matching the valid_from/valid_to convention.
            attributes: { dataUpdatedAt: "1999-01-01T00:00:00Z" },
          },
        },
      ],
    } as unknown as FeatureCollection);
    expect(out[0]?.dataUpdatedAt).toBe("2026-06-22T05:30:00Z");
  });

  it("maps a feed observation to originKind 'feed' (routing-authoritative)", () => {
    const out = featureCollectionToRoadConditionEvents({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [5, 52] },
          properties: {
            id: "ndw:2",
            type: "road_closure",
            originKind: "feed",
            // Feeds carry null evidence fields from the projection.
            evidenceState: undefined,
            routingEligible: undefined,
            confidenceScore: undefined,
          },
        },
      ],
    } as unknown as FeatureCollection);
    expect(out[0]).toMatchObject({ originKind: "feed" });
    expect(out[0]?.routingEligible).toBeUndefined();
    expect(out[0]?.evidenceState).toBeUndefined();
  });

  it("maps a crowd observation carrying its evidence fields through", () => {
    const out = featureCollectionToRoadConditionEvents({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [5, 52] },
          properties: {
            id: "crowd:1",
            type: "road_closure",
            originKind: "crowd",
            evidenceState: "self_reported",
            routingEligible: false,
            confidenceScore: 0.4,
          },
        },
      ],
    } as unknown as FeatureCollection);
    expect(out[0]).toMatchObject({
      originKind: "crowd",
      evidenceState: "self_reported",
      routingEligible: false,
      confidenceScore: 0.4,
    });
  });

  it("falls back to origin.kind when originKind is not flattened onto properties", () => {
    const out = featureCollectionToRoadConditionEvents({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [5, 52] },
          properties: {
            id: "crowd:2",
            type: "road_closure",
            origin: { kind: "crowd" },
            routingEligible: true,
          },
        },
      ],
    } as unknown as FeatureCollection);
    expect(out[0]).toMatchObject({ originKind: "crowd", routingEligible: true });
  });

  it("leaves origin fields undefined for a provider that omits them", () => {
    const out = featureCollectionToRoadConditionEvents({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 1] },
          properties: { id: "x", type: "road_closure" },
        },
      ],
    } as unknown as FeatureCollection);
    expect(out[0]?.originKind).toBeUndefined();
    expect(out[0]?.routingEligible).toBeUndefined();
  });

  it("defaults type/severity when absent", () => {
    const out = featureCollectionToRoadConditionEvents({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 1] },
          properties: { id: "x" },
        },
      ],
    });
    expect(out[0]).toMatchObject({ type: "other", severity: "unknown", headline: "" });
  });
});
