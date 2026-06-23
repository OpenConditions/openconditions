import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWzdx } from "../wzdx.js";
import { mapSourceType } from "../taxonomy.js";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures/wzdx/feed.json");

const WZDX_SOURCE = {
  id: "test-dot",
  attribution: "TestDOT",
  country: "US",
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
} as const;

describe("parseWzdx — WZDx v4.2 fixture", () => {
  it("parses at least one RoadEvent with a GeoJSON geometry", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.geometry).toBeDefined();
    expect(events[0]!.geometry.type).toMatch(
      /^(Point|LineString|Polygon|MultiPoint|MultiLineString|MultiPolygon)$/
    );
  });

  it("emits sourceFormat:'wzdx' and domain:'roads' on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    expect(events.every((ev) => ev.sourceFormat === "wzdx")).toBe(true);
    expect(events.every((ev) => ev.domain === "roads")).toBe(true);
  });

  it("maps work-zone features to type:'roadworks' with isPlanned:true", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    const workzone = events.find((ev) => ev.subtype === "work-zone");
    expect(workzone).toBeDefined();
    expect(workzone!.type).toBe("roadworks");
    expect(workzone!.isPlanned).toBe(true);
  });

  it("maps detour features to type:'detour' with isPlanned:false", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    const detour = events.find((ev) => ev.subtype === "detour");
    expect(detour).toBeDefined();
    expect(detour!.type).toBe("detour");
    expect(detour!.isPlanned).toBe(false);
  });

  it("sets severitySource:'derived' on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    expect(events.every((ev) => ev.severitySource === "derived")).toBe(true);
  });

  it("derives higher severity for all-lanes-closed vs all-lanes-open", () => {
    const severityRank = (s: string) => {
      switch (s) {
        case "critical":
          return 4;
        case "high":
          return 3;
        case "medium":
          return 2;
        case "low":
          return 1;
        default:
          return 0;
      }
    };

    const makeFeed = (id: string, vehicleImpact: string, lng: number) => ({
      type: "FeatureCollection",
      features: [
        {
          id,
          type: "Feature",
          properties: {
            core_details: { event_type: "work-zone", road_names: ["I-80"] },
            vehicle_impact: vehicleImpact,
          },
          geometry: {
            type: "LineString",
            coordinates: [
              [lng, 41.0],
              [lng + 0.01, 41.01],
            ],
          },
        },
      ],
    });

    const [closedEv] = parseWzdx(makeFeed("closed", "all-lanes-closed", -93.0), WZDX_SOURCE);
    const [openEv] = parseWzdx(makeFeed("open", "all-lanes-open", -94.0), WZDX_SOURCE);

    expect(closedEv).toBeDefined();
    expect(openEv).toBeDefined();
    expect(severityRank(closedEv!.severity)).toBeGreaterThan(severityRank(openEv!.severity));
  });

  it("populates lanesAffected from lanes[] array", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    const withLanes = events.find(
      (ev) => ev.lanesAffected?.lanes && ev.lanesAffected.lanes.length > 0
    );
    expect(withLanes).toBeDefined();
    expect(withLanes!.lanesAffected!.lanes!.length).toBeGreaterThan(0);
    expect(withLanes!.lanesAffected!.lanes![0]).toMatchObject({
      index: expect.any(Number),
      status: expect.stringMatching(/^(open|closed|alternating)$/),
    });
  });

  it("counts closed and total lanes from lanes[] data", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    const withLanes = events.find(
      (ev) => ev.lanesAffected?.lanes && ev.lanesAffected.lanes.length > 0
    );
    expect(withLanes).toBeDefined();
    expect(withLanes!.lanesAffected!.total).toBeGreaterThan(0);
    expect(withLanes!.lanesAffected!.closed).toBeGreaterThanOrEqual(0);
  });

  it("maps road_names and direction into roads[] RoadRef array", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    const withRoads = events.find((ev) => ev.roads.length > 0);
    expect(withRoads).toBeDefined();
    expect(withRoads!.roads[0]!.name).toBeDefined();
    expect(withRoads!.roads[0]!.name.length).toBeGreaterThan(0);
  });

  it("extracts validFrom and validTo from start_date / end_date", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    const withDates = events.find((ev) => ev.validFrom != null && ev.validTo != null);
    expect(withDates).toBeDefined();
    expect(withDates!.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(withDates!.validTo).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("prefixes event id with source id", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    expect(events.every((ev) => ev.id.startsWith("test-dot:"))).toBe(true);
  });

  it("sets kind:'event' and isStale:false on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    expect(events.every((ev) => ev.kind === "event")).toBe(true);
    expect(events.every((ev) => ev.isStale === false)).toBe(true);
  });

  it("carries license from the source descriptor via origin", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    for (const ev of events) {
      expect(ev.origin.kind).toBe("feed");
      if (ev.origin.kind === "feed") {
        expect(ev.origin.attribution.license).toBe("CC0-1.0");
      }
    }
  });

  it("accepts a pre-parsed object as well as a JSON string", () => {
    const obj = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const events = parseWzdx(obj, WZDX_SOURCE);
    expect(events.length).toBeGreaterThan(0);
  });

  it("skips features with no geometry and does not throw", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "no-geo",
          type: "Feature",
          properties: {
            core_details: {
              event_type: "work-zone",
              road_names: ["I-80"],
              direction: "northbound",
            },
            vehicle_impact: "some-lanes-closed",
            start_date: "2024-01-01T00:00:00Z",
          },
          geometry: null,
        },
        {
          id: "has-geo",
          type: "Feature",
          properties: {
            core_details: {
              event_type: "work-zone",
              road_names: ["I-90"],
              direction: "eastbound",
            },
            vehicle_impact: "all-lanes-closed",
            start_date: "2024-01-01T00:00:00Z",
          },
          geometry: {
            type: "LineString",
            coordinates: [
              [-93.0, 41.0],
              [-93.1, 41.1],
            ],
          },
        },
      ],
    };

    const events = parseWzdx(feed, WZDX_SOURCE);
    expect(events.length).toBe(1);
    expect(events[0]!.id).toContain("has-geo");
  });

  it("never throws on empty features array", () => {
    expect(() => parseWzdx({ type: "FeatureCollection", features: [] }, WZDX_SOURCE)).not.toThrow();
    expect(parseWzdx({ type: "FeatureCollection", features: [] }, WZDX_SOURCE)).toEqual([]);
  });

  it("never throws on invalid JSON string", () => {
    expect(() => parseWzdx("not-valid-json", WZDX_SOURCE)).not.toThrow();
    expect(parseWzdx("not-valid-json", WZDX_SOURCE)).toEqual([]);
  });

  it("derives 'high' severity for all-lanes-closed vehicle impact", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "closed-test",
          type: "Feature",
          properties: {
            core_details: { event_type: "work-zone", road_names: ["US-1"] },
            vehicle_impact: "all-lanes-closed",
          },
          geometry: { type: "Point", coordinates: [-80.0, 25.0] },
        },
      ],
    };
    const events = parseWzdx(feed, WZDX_SOURCE);
    expect(events[0]!.severity).toBe("high");
  });

  it("derives 'unknown' severity for all-lanes-open vehicle impact", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "open-test",
          type: "Feature",
          properties: {
            core_details: { event_type: "work-zone", road_names: ["US-1"] },
            vehicle_impact: "all-lanes-open",
          },
          geometry: { type: "Point", coordinates: [-80.0, 25.0] },
        },
      ],
    };
    const events = parseWzdx(feed, WZDX_SOURCE);
    expect(events[0]!.severity).toBe("unknown");
  });
});

describe("mapSourceType — wzdx branch", () => {
  it("maps work-zone to roadworks/planned/isPlanned:true", () => {
    expect(mapSourceType("wzdx", "work-zone")).toEqual({
      type: "roadworks",
      category: "planned",
      isPlanned: true,
    });
  });

  it("maps detour to detour/conditions/isPlanned:false", () => {
    expect(mapSourceType("wzdx", "detour")).toEqual({
      type: "detour",
      category: "conditions",
      isPlanned: false,
    });
  });

  it("maps unknown WZDx event_type to other", () => {
    expect(mapSourceType("wzdx", "unknown-event-type")).toEqual({
      type: "other",
      category: "conditions",
      isPlanned: false,
    });
  });
});

describe("parseWzdx — extended fields", () => {
  it("maps speed limit, restrictions, milepost/cross-street, related events, and raw", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "f1",
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [-100, 40],
              [-100.1, 40.1],
            ],
          },
          properties: {
            core_details: {
              event_type: "work-zone",
              road_names: ["I-5"],
              direction: "northbound",
              related_road_events: [{ id: "evt-2", type: "work-zone" }],
            },
            reduced_speed_limit_kph: 50,
            restrictions: [{ type: "reduced-width", value: 3, unit: "meters" }],
            beginning_milepost: 10,
            ending_milepost: 12,
            beginning_cross_street: "Main St",
            ending_cross_street: "Oak Ave",
            start_date: "2026-01-01T00:00:00Z",
          },
        },
      ],
    };
    const [ev] = parseWzdx(JSON.stringify(feed), WZDX_SOURCE);
    expect(ev!.speedLimitKph).toBe(50);
    expect(ev!.restrictions).toEqual([{ type: "reduced-width", value: 3, unit: "meters" }]);
    expect(ev!.roads[0]!.milepostFrom).toBe(10);
    expect(ev!.roads[0]!.milepostTo).toBe(12);
    expect(ev!.roads[0]!.from).toBe("Main St");
    expect(ev!.roads[0]!.to).toBe("Oak Ave");
    expect(ev!.relatedIds).toEqual(["evt-2"]);
    expect(ev!.sourceRaw?.["reduced_speed_limit_kph"]).toBe(50);
  });
});
