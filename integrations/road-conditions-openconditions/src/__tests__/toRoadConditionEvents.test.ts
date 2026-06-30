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
