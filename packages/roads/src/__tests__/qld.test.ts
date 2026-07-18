import { describe, expect, it } from "vitest";
import { FEED_SOURCES, feedToSourceDescriptor } from "../feeds.js";
import { parseGeoJson } from "../geojson.js";

/**
 * QLDTraffic mapping, verified against the official API specification v1.10
 * (qldtraffic.qld.gov.au API specification). The fixture mirrors the documented
 * response shape: a FeatureCollection whose features carry a GeometryCollection
 * of LineString/Point road segments and the documented `properties` (event_type
 * enum, event_priority, road_summary, last_updated, …).
 */
const SRC = feedToSourceDescriptor(FEED_SOURCES.find((f) => f.id === "au-qld-traffic")!);

function feature(props: Record<string, unknown>, lng: number, lat: number) {
  return {
    type: "Feature" as const,
    geometry: {
      type: "GeometryCollection" as const,
      geometries: [
        {
          type: "LineString" as const,
          coordinates: [
            [lng, lat],
            [lng + 0.001, lat + 0.001],
          ],
        },
      ],
    },
    properties: props,
  };
}

const FIXTURE = JSON.stringify({
  type: "FeatureCollection",
  features: [
    feature(
      {
        id: 101,
        status: "Published",
        event_type: "Roadworks",
        event_subtype: "Planned roadworks",
        event_priority: "Low",
        description: "Resurfacing on the Bruce Highway",
        information: "Reduced speed limit in place",
        road_summary: { road_name: "Bruce Highway", locality: "Gympie", district: "North Coast" },
        last_updated: "2026-06-20T11:37:19.448257+10:00",
      },
      153.02,
      -27.34
    ),
    feature(
      {
        id: 102,
        event_type: "Special event",
        event_priority: "Medium",
        description: "Brisbane Festival road closures",
        road_summary: { road_name: "Grey Street" },
      },
      153.5,
      -27.9
    ),
    feature(
      {
        id: 103,
        event_type: "Crash",
        event_priority: "Red Alert",
        description: "Multi-vehicle crash blocking all lanes",
        road_summary: { road_name: "Pacific Motorway" },
      },
      153.1,
      -28.0
    ),
    feature(
      { id: 104, event_type: "Flooding", event_priority: "High", description: "Water over road" },
      152.0,
      -26.0
    ),
  ],
});

describe("QLDTraffic mapping (spec v1.10)", () => {
  const events = parseGeoJson(FIXTURE, SRC);
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));

  it("maps every documented event_type enum value to the canonical taxonomy", () => {
    expect(events).toHaveLength(4);
    expect(byId["au-qld-traffic:101"]!.type).toBe("roadworks");
    expect(byId["au-qld-traffic:102"]!.type).toBe("public_event");
    expect(byId["au-qld-traffic:103"]!.type).toBe("accident");
    expect(byId["au-qld-traffic:104"]!.type).toBe("weather");
  });

  it("maps event_priority to severity (Red Alert → critical)", () => {
    expect(byId["au-qld-traffic:101"]!.severity).toBe("low");
    expect(byId["au-qld-traffic:102"]!.severity).toBe("medium");
    expect(byId["au-qld-traffic:103"]!.severity).toBe("critical");
    expect(byId["au-qld-traffic:104"]!.severity).toBe("high");
    expect(byId["au-qld-traffic:103"]!.severitySource).toBe("declared");
  });

  it("reads the road name from the nested road_summary and the headline from description", () => {
    expect(byId["au-qld-traffic:101"]!.roads[0]?.name).toBe("Bruce Highway");
    expect(byId["au-qld-traffic:101"]!.headline).toBe("Resurfacing on the Bruce Highway");
    expect(byId["au-qld-traffic:101"]!.description).toBe("Reduced speed limit in place");
  });

  it("uses last_updated as dataUpdatedAt and preserves the GeometryCollection", () => {
    expect(byId["au-qld-traffic:101"]!.dataUpdatedAt).toBe("2026-06-20T11:37:19.448257+10:00");
    expect(byId["au-qld-traffic:101"]!.geometry.type).toBe("GeometryCollection");
  });
});
