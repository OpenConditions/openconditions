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

  it("returns [] without throwing when a feed returns HTML instead of JSON", () => {
    expect(parseWzdx("<!DOCTYPE html><html><body>Forbidden</body></html>", WZDX_SOURCE)).toEqual(
      []
    );
    expect(parseWzdx("  \n  <html></html>", WZDX_SOURCE)).toEqual([]);
  });

  it("returns [] without throwing on malformed JSON", () => {
    expect(parseWzdx("{not json", WZDX_SOURCE)).toEqual([]);
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

describe("parseWzdx — relatedEvents (relationship type)", () => {
  it("maps related_road_events[] into relatedEvents with id and type", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    const detour = events.find((ev) => ev.subtype === "detour");
    expect(detour).toBeDefined();
    expect(detour!.relatedEvents).toEqual([
      { id: "a15f7570-b7e6-4367-8ad9-3a462eea65dd", type: "related-work-zone" },
      { id: "4d151e7d-11d8-4b99-a192-51e189da0de7", type: "next-in-sequence" },
    ]);
  });

  it("keeps the bare relatedIds alongside relatedEvents", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    const detour = events.find((ev) => ev.subtype === "detour");
    expect(detour).toBeDefined();
    expect(detour!.relatedIds).toEqual([
      "a15f7570-b7e6-4367-8ad9-3a462eea65dd",
      "4d151e7d-11d8-4b99-a192-51e189da0de7",
    ]);
  });

  it("includes entries with an id but no relationship type", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "f1",
          type: "Feature",
          geometry: { type: "Point", coordinates: [-100, 40] },
          properties: {
            core_details: {
              event_type: "work-zone",
              road_names: ["I-5"],
              related_road_events: [{ id: "evt-2" }, { id: "evt-3", type: "first-occurrence" }],
            },
          },
        },
      ],
    };
    const [ev] = parseWzdx(JSON.stringify(feed), WZDX_SOURCE);
    expect(ev!.relatedEvents).toEqual([{ id: "evt-2" }, { id: "evt-3", type: "first-occurrence" }]);
  });

  it("leaves relatedEvents unset when there are no related_road_events", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "f1",
          type: "Feature",
          geometry: { type: "Point", coordinates: [-100, 40] },
          properties: {
            core_details: { event_type: "work-zone", road_names: ["I-5"] },
          },
        },
      ],
    };
    const [ev] = parseWzdx(JSON.stringify(feed), WZDX_SOURCE);
    expect(ev!.relatedEvents).toBeUndefined();
  });
});

describe("parseWzdx — confidence from date verification", () => {
  it("sets confidence:'observed' when is_start_date_verified is true", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseWzdx(json, WZDX_SOURCE);

    const detour = events.find((ev) => ev.subtype === "detour");
    expect(detour).toBeDefined();
    expect(detour!.confidence).toBe("observed");
  });

  it("sets confidence:'observed' when start_date_accuracy is 'verified'", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "f1",
          type: "Feature",
          geometry: { type: "Point", coordinates: [-100, 40] },
          properties: {
            core_details: { event_type: "work-zone", road_names: ["I-5"] },
            start_date_accuracy: "verified",
          },
        },
      ],
    };
    const [ev] = parseWzdx(JSON.stringify(feed), WZDX_SOURCE);
    expect(ev!.confidence).toBe("observed");
  });

  it("sets confidence:'likely' when start_date_accuracy is 'estimated'", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "f1",
          type: "Feature",
          geometry: { type: "Point", coordinates: [-100, 40] },
          properties: {
            core_details: { event_type: "work-zone", road_names: ["I-5"] },
            start_date_accuracy: "estimated",
          },
        },
      ],
    };
    const [ev] = parseWzdx(JSON.stringify(feed), WZDX_SOURCE);
    expect(ev!.confidence).toBe("likely");
  });

  it("sets confidence:'possible' when worker_presence.confidence is 'low' and no date signal", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "f1",
          type: "Feature",
          geometry: { type: "Point", coordinates: [-100, 40] },
          properties: {
            core_details: { event_type: "work-zone", road_names: ["I-5"] },
            worker_presence: { are_workers_present: true, confidence: "low" },
          },
        },
      ],
    };
    const [ev] = parseWzdx(JSON.stringify(feed), WZDX_SOURCE);
    expect(ev!.confidence).toBe("possible");
  });

  it("prefers the date-accuracy signal over worker_presence confidence", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "f1",
          type: "Feature",
          geometry: { type: "Point", coordinates: [-100, 40] },
          properties: {
            core_details: { event_type: "work-zone", road_names: ["I-5"] },
            start_date_accuracy: "estimated",
            worker_presence: { are_workers_present: true, confidence: "low" },
          },
        },
      ],
    };
    const [ev] = parseWzdx(JSON.stringify(feed), WZDX_SOURCE);
    expect(ev!.confidence).toBe("likely");
  });

  it("leaves confidence unset when no verification signal is present", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "f1",
          type: "Feature",
          geometry: { type: "Point", coordinates: [-100, 40] },
          properties: {
            core_details: { event_type: "work-zone", road_names: ["I-5"] },
            is_start_date_verified: false,
          },
        },
      ],
    };
    const [ev] = parseWzdx(JSON.stringify(feed), WZDX_SOURCE);
    expect(ev!.confidence).toBeUndefined();
  });
});

describe("parseWzdx — deeper field extraction", () => {
  it("maps types_of_work→subtype, worker_presence, work_zone_type, event_status→status, name→label, per-lane restrictions, creation_date", () => {
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
              road_names: ["I-10"],
              name: "Big Dig",
              creation_date: "2026-01-01T00:00:00Z",
            },
            types_of_work: [{ type_name: "surface-work" }],
            worker_presence: { are_workers_present: true },
            work_zone_type: "moving",
            event_status: "completed",
            start_date: "2026-01-01T00:00:00Z",
            lanes: [
              {
                order: 1,
                status: "closed",
                type: "general",
                restrictions: [{ type: "reduced-width", value: 3, unit: "meters" }],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseWzdx(JSON.stringify(feed), WZDX_SOURCE);
    expect(ev!.subtype).toBe("surface-work");
    expect(ev!.workersPresent).toBe(true);
    expect(ev!.workZoneType).toBe("moving");
    expect(ev!.status).toBe("archived");
    expect(ev!.label).toBe("Big Dig");
    expect(ev!.dataUpdatedAt).toBe("2026-01-01T00:00:00Z");
    expect(ev!.lanesAffected?.lanes?.[0]?.restrictions).toEqual([
      { type: "reduced-width", value: 3, unit: "meters" },
    ]);
  });
});

describe("parseWzdx — statewide Missouri v4.1 feed (registry format label 'json')", () => {
  const MODOT = join(import.meta.dirname, "fixtures/wzdx/modot-v41.json");
  const MODOT_SOURCE = { ...WZDX_SOURCE, id: "wzdx-missouri", attribution: "MoDOT" } as const;

  it("parses the same v4 shape the registry mislabels as plain json", () => {
    const events = parseWzdx(readFileSync(MODOT, "utf8"), MODOT_SOURCE);
    expect(events).toHaveLength(2);
    for (const ev of events) {
      expect(ev.sourceFormat).toBe("wzdx");
      expect(ev.type).toBe("roadworks");
      expect(ev.category).toBe("planned");
      expect(ev.isPlanned).toBe(true);
      expect(ev.geometry.type).toBe("LineString");
    }
  });

  it("reads validity, roads and lane impact off the core details", () => {
    const events = parseWzdx(readFileSync(MODOT, "utf8"), MODOT_SOURCE);
    // MoDOT publishes a single data source, so ids read `<src>:<data_source_id>:<id>`.
    const closed = events.find((e) => e.id === "wzdx-missouri:tms_work_zone:552055");
    expect(closed).toBeDefined();
    expect(closed!.validFrom).toBe("2026-05-29T05:00:00.0000000Z");
    expect(closed!.validTo).toBe("2026-08-31T05:00:00.0000000Z");
    expect(closed!.roadState).toBe("closed");
    expect(closed!.roads?.map((r) => r.name)).toContain("K");
    expect(closed!.description).toBe("BRIDGE RECONSTRUCTION");

    const partial = events.find((e) => e.id === "wzdx-missouri:tms_work_zone:549748");
    expect(partial!.roadState).toBe("some_lanes_closed");
  });
});

describe("parseWzdx — Québec City v3.1 feed (core fields on properties)", () => {
  const QC = join(import.meta.dirname, "fixtures/wzdx/quebec-v31.json");
  const QC_SOURCE = { ...WZDX_SOURCE, id: "wzdx-quebec", attribution: "Ville de Québec" } as const;

  it("lifts the v3 core fields so events classify instead of all landing as `other`", () => {
    const events = parseWzdx(readFileSync(QC, "utf8"), QC_SOURCE);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type !== "other")).toBe(true);

    const wz = events.find((e) => e.type === "roadworks");
    expect(wz).toBeDefined();
    expect(wz!.category).toBe("planned");
    expect(wz!.isPlanned).toBe(true);
    expect(wz!.roads?.map((r) => r.name)).toContain("Rue de Maisonneuve");
    expect(wz!.roadState).toBe("some_lanes_closed");
    expect(wz!.description).toContain("Rue de Maisonneuve");
  });

  it("maps a v3 detour record to the detour type", () => {
    const events = parseWzdx(readFileSync(QC, "utf8"), QC_SOURCE);
    const detour = events.find((e) => e.type === "detour");
    expect(detour).toBeDefined();
    expect(detour!.roads?.map((r) => r.name)).toContain("Rue Adanac");
  });

  it("keeps the v3 ids and validity window", () => {
    const events = parseWzdx(readFileSync(QC, "utf8"), QC_SOURCE);
    const wz = events.find((e) => e.type === "roadworks")!;
    expect(wz.id).toContain("TIC-Quebec/1:");
    expect(wz.validFrom).toBeTruthy();
    expect(wz.validTo).toBeTruthy();
  });

  it("leaves an already-v4 body untouched", () => {
    // The v4 fixture must classify identically after the lift is in place.
    const events = parseWzdx(readFileSync(FIXTURE_PATH, "utf8"), WZDX_SOURCE);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "roadworks")).toBe(true);
  });
});

describe("parseWzdx — CWZ 1.0 spike (characterisation, feed not enabled)", () => {
  const CWZ = join(import.meta.dirname, "fixtures/wzdx/cwz-pbs.json");
  const CWZ_SOURCE = {
    ...WZDX_SOURCE,
    id: "cwz-pbs",
    attribution: "PurposeBuilt Systems",
  } as const;

  // Captured live from the one unkeyed CWZ 1.0 registry row. Its body is an
  // ordinary core_details-shaped FeatureCollection, so the v4 parser reads it
  // with no adapter — but the whole feed carries a single work zone. That, plus
  // two placeholder-key rows and a key-gated MassDOT, is why CWZ stays out of
  // the resolver: the standard needs no new code, it just has no coverage yet.
  it("reads a CWZ 1.0 body with the v4 parser, with no adapter", () => {
    const events = parseWzdx(readFileSync(CWZ, "utf8"), CWZ_SOURCE);
    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev!.type).toBe("roadworks");
    expect(ev!.category).toBe("planned");
    expect(ev!.roads?.map((r) => r.name)).toContain("US-30 E");
    expect(ev!.roadState).toBe("closed");
    expect(ev!.geometry.type).toBe("LineString");
  });
});
