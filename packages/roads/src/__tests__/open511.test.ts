import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseOpen511 } from "../open511.js";
import { mapSourceType } from "../taxonomy.js";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures/drivebc/events.json");

const DRIVEBC_SOURCE = {
  id: "drivebc",
  attribution: "DriveBC / BC Ministry of Transportation",
  country: "CA",
  license: "OGL-BC",
  licenseUrl: "https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc",
} as const;

describe("parseOpen511 — DriveBC fixture", () => {
  it("parses at least one RoadEvent with a GeoJSON geometry", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.geometry).toBeDefined();
    expect(events[0]!.geometry.type).toMatch(
      /^(Point|LineString|Polygon|MultiPoint|MultiLineString|MultiPolygon)$/
    );
  });

  it("emits sourceFormat:'open511' and domain:'roads' on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    expect(events.every((ev) => ev.sourceFormat === "open511")).toBe(true);
    expect(events.every((ev) => ev.domain === "roads")).toBe(true);
  });

  it("maps every event to a valid RoadEventType", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    for (const ev of events) {
      expect(ev.type).toBeDefined();
    }
  });

  it("sets severitySource:'declared' on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    expect(events.every((ev) => ev.severitySource === "declared")).toBe(true);
  });

  it("maps a CONSTRUCTION event to roadworks type with isPlanned:true", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    const construction = events.find((ev) => ev.type === "roadworks");
    expect(construction).toBeDefined();
    expect(construction!.isPlanned).toBe(true);
  });

  it("maps an INCIDENT event to a non-planned type", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    const incident = events.find((ev) => {
      const raw = (ev.sourceRaw as { event_type?: string } | undefined)?.event_type;
      return ev.isPlanned === false && raw === "INCIDENT";
    });
    expect(incident).toBeDefined();
  });

  it("prefixes event id with source id", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    expect(events.every((ev) => ev.id.startsWith("drivebc:"))).toBe(true);
  });

  it("carries OGL-BC license from the source descriptor via origin", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    for (const ev of events) {
      expect(ev.origin.kind).toBe("feed");
      if (ev.origin.kind === "feed") {
        expect(ev.origin.attribution.license).toBe("OGL-BC");
      }
    }
  });

  it("sets kind:'event' and isStale:false on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    expect(events.every((ev) => ev.kind === "event")).toBe(true);
    expect(events.every((ev) => ev.isStale === false)).toBe(true);
  });

  it("extracts schedule interval as validFrom/validTo", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    const withInterval = events.find((ev) => ev.validFrom != null);
    expect(withInterval).toBeDefined();
    expect(withInterval!.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("parses roads[] into RoadRef array", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    const withRoads = events.find((ev) => ev.roads.length > 0);
    expect(withRoads).toBeDefined();
    expect(withRoads!.roads[0]!.name).toBeDefined();
  });

  it("collects +-prefixed extension fields into externalRefs", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseOpen511(json, DRIVEBC_SOURCE);

    const withRefs = events.find((ev) => ev.externalRefs != null);
    expect(withRefs).toBeDefined();

    const linear = withRefs!.externalRefs?.linear as Record<string, unknown> | undefined;
    expect(linear).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(linear, "+ivr_message")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(linear, "+linear_reference_km")).toBe(true);
  });

  it("accepts a pre-parsed object as well as a JSON string", () => {
    const obj = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const events = parseOpen511(obj, DRIVEBC_SOURCE);

    expect(events.length).toBeGreaterThan(0);
  });

  it("skips events with no geography and does not throw", () => {
    const payload = {
      events: [
        {
          id: "test/NO-GEO",
          event_type: "INCIDENT",
          severity: "MINOR",
          status: "ACTIVE",
          headline: "No geometry",
          roads: [],
          schedule: {},
        },
        {
          id: "test/HAS-GEO",
          event_type: "CONSTRUCTION",
          severity: "MAJOR",
          status: "ACTIVE",
          headline: "With geometry",
          roads: [],
          schedule: {},
          geography: { type: "Point", coordinates: [-123.0, 49.0] },
        },
      ],
    };

    const events = parseOpen511(payload, DRIVEBC_SOURCE);
    expect(events.length).toBe(1);
    expect(events[0]!.id).toBe("drivebc:HAS-GEO");
  });

  it("never throws on empty events array", () => {
    expect(() => parseOpen511({ events: [] }, DRIVEBC_SOURCE)).not.toThrow();
    expect(parseOpen511({ events: [] }, DRIVEBC_SOURCE)).toEqual([]);
  });

  it("never throws on completely missing events field", () => {
    expect(() => parseOpen511({}, DRIVEBC_SOURCE)).not.toThrow();
  });
});

describe("mapSourceType — open511 branch", () => {
  it("maps CONSTRUCTION to roadworks/planned/isPlanned:true", () => {
    expect(mapSourceType("open511", "CONSTRUCTION")).toEqual({
      type: "roadworks",
      category: "planned",
      isPlanned: true,
    });
  });

  it("maps INCIDENT to accident/incident/isPlanned:false", () => {
    expect(mapSourceType("open511", "INCIDENT")).toEqual({
      type: "accident",
      category: "incident",
      isPlanned: false,
    });
  });

  it("maps SPECIAL_EVENT to public_event/planned/isPlanned:true", () => {
    expect(mapSourceType("open511", "SPECIAL_EVENT")).toEqual({
      type: "public_event",
      category: "planned",
      isPlanned: true,
    });
  });

  it("maps WEATHER_CONDITION to weather/conditions/isPlanned:false", () => {
    expect(mapSourceType("open511", "WEATHER_CONDITION")).toEqual({
      type: "weather",
      category: "conditions",
      isPlanned: false,
    });
  });

  it("maps ROAD_CONDITION to road_condition/conditions/isPlanned:false", () => {
    expect(mapSourceType("open511", "ROAD_CONDITION")).toEqual({
      type: "road_condition",
      category: "conditions",
      isPlanned: false,
    });
  });

  it("maps unknown open511 event_type to other", () => {
    expect(mapSourceType("open511", "SOMETHING_WEIRD")).toEqual({
      type: "other",
      category: "conditions",
      isPlanned: false,
    });
  });
});

describe("parseOpen511 — road state", () => {
  const event = (state: string) =>
    JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "INCIDENT",
          geography: { type: "Point", coordinates: [-123, 49] },
          roads: [{ name: "Hwy 1", state }],
        },
      ],
    });

  it("maps Open511 roads[].state to roadState", () => {
    expect(parseOpen511(event("ALL_LANES_CLOSED"), DRIVEBC_SOURCE)[0]!.roadState).toBe("closed");
    expect(parseOpen511(event("SOME_LANES_CLOSED"), DRIVEBC_SOURCE)[0]!.roadState).toBe(
      "some_lanes_closed"
    );
    expect(parseOpen511(event("SINGLE_LANE_ALTERNATING"), DRIVEBC_SOURCE)[0]!.roadState).toBe(
      "single_lane_alternating"
    );
  });
});

describe("parseOpen511 — extended fields", () => {
  it("maps recurring_schedules→schedule, event_subtypes→subtype, and preserves the raw event", () => {
    const json = JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "CONSTRUCTION",
          event_subtypes: ["ROAD_CONSTRUCTION"],
          geography: { type: "Point", coordinates: [-123, 49] },
          schedule: {
            recurring_schedules: [
              { days: [1, 2, 3], daily_start_time: "08:00", daily_end_time: "17:00" },
            ],
          },
        },
      ],
    });
    const [ev] = parseOpen511(json, DRIVEBC_SOURCE);
    expect(ev!.subtype).toBe("ROAD_CONSTRUCTION");
    expect(ev!.schedule).toEqual([
      {
        repeatFrequency: "P1W",
        startTime: "08:00",
        endTime: "17:00",
        duration: "PT9H",
        byDay: ["MO", "TU", "WE"],
        scheduleTimezone: "America/Vancouver",
      },
    ]);
    expect(ev!.sourceRaw?.["event_type"]).toBe("CONSTRUCTION");
  });
});

describe("parseOpen511 — deeper field extraction", () => {
  it("maps recurring date range and regions from the DriveBC fixture", () => {
    const events = parseOpen511(readFileSync(FIXTURE_PATH, "utf8"), DRIVEBC_SOURCE);
    expect(events.some((e) => e.schedule?.some((w) => w.startDate != null))).toBe(true);
    expect(events.some((e) => (e.regions?.length ?? 0) > 0)).toBe(true);
  });

  it("maps lanes_open/closed→lanesAffected, direction, grouped_events→relatedIds (synthetic)", () => {
    const json = JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "INCIDENT",
          geography: { type: "Point", coordinates: [-123, 49] },
          roads: [{ name: "Hwy 1", direction: "N", lanes_open: 1, lanes_closed: 2 }],
          grouped_events: ["https://x/events/9"],
        },
      ],
    });
    const [ev] = parseOpen511(json, DRIVEBC_SOURCE);
    expect(ev!.lanesAffected).toEqual({ closed: 2, total: 3 });
    expect(ev!.direction).toBe("N");
    expect(ev!.relatedIds).toEqual(["https://x/events/9"]);
  });
});

describe("parseOpen511 — GeoNames external reference", () => {
  it("extracts externalRefs.external from a geonames.org area url (synthetic)", () => {
    const json = JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "INCIDENT",
          geography: { type: "Point", coordinates: [-123, 49] },
          areas: [{ url: "https://geonames.org/8630138", name: "Okanagan" }],
        },
      ],
    });
    const [ev] = parseOpen511(json, DRIVEBC_SOURCE);
    expect(ev!.externalRefs?.external).toEqual({ system: "geonames", code: "8630138" });
  });

  it("handles www.geonames.org urls and keeps regions from area names (synthetic)", () => {
    const json = JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "INCIDENT",
          geography: { type: "Point", coordinates: [-123, 49] },
          areas: [{ url: "http://www.geonames.org/8630136", name: "Lower Mainland District" }],
        },
      ],
    });
    const [ev] = parseOpen511(json, DRIVEBC_SOURCE);
    expect(ev!.externalRefs?.external).toEqual({ system: "geonames", code: "8630136" });
    expect(ev!.regions).toEqual(["Lower Mainland District"]);
  });

  it("uses the first geonames area url when several areas are present (synthetic)", () => {
    const json = JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "INCIDENT",
          geography: { type: "Point", coordinates: [-123, 49] },
          areas: [
            { name: "No url here" },
            { url: "https://example.com/not-geonames", name: "Other" },
            { url: "https://www.geonames.org/12345", name: "First geonames" },
            { url: "https://geonames.org/67890", name: "Second geonames" },
          ],
        },
      ],
    });
    const [ev] = parseOpen511(json, DRIVEBC_SOURCE);
    expect(ev!.externalRefs?.external).toEqual({ system: "geonames", code: "12345" });
  });

  it("leaves externalRefs.external unset when no geonames area url is present (synthetic)", () => {
    const json = JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "INCIDENT",
          geography: { type: "Point", coordinates: [-123, 49] },
          areas: [{ url: "https://example.com/region/1", name: "Somewhere" }],
        },
      ],
    });
    const [ev] = parseOpen511(json, DRIVEBC_SOURCE);
    expect(ev!.externalRefs?.external).toBeUndefined();
  });

  it("merges external with linear extension fields without clobbering (synthetic)", () => {
    const json = JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "INCIDENT",
          geography: { type: "Point", coordinates: [-123, 49] },
          areas: [{ url: "https://geonames.org/8630138", name: "Okanagan" }],
          "+ivr_message": "hello",
        },
      ],
    });
    const [ev] = parseOpen511(json, DRIVEBC_SOURCE);
    expect(ev!.externalRefs?.external).toEqual({ system: "geonames", code: "8630138" });
    const linear = ev!.externalRefs?.linear as Record<string, unknown> | undefined;
    expect(linear?.["+ivr_message"]).toBe("hello");
  });

  it("extracts geonames external refs from the DriveBC fixture", () => {
    const events = parseOpen511(readFileSync(FIXTURE_PATH, "utf8"), DRIVEBC_SOURCE);
    const withExternal = events.filter((e) => e.externalRefs?.external != null);
    expect(withExternal.length).toBeGreaterThan(0);
    for (const ev of withExternal) {
      expect(ev.externalRefs!.external!.system).toBe("geonames");
      expect(ev.externalRefs!.external!.code).toMatch(/^\d+$/);
    }
  });
});

describe("parseOpen511 — milepost from linear reference", () => {
  const eventWithLinearKm = (linearKm: unknown) =>
    JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "INCIDENT",
          geography: { type: "Point", coordinates: [-123, 49] },
          roads: [{ name: "Hwy 1" }],
          "+linear_reference_km": linearKm,
        },
      ],
    });

  it("sets roads[0].milepostFrom from +linear_reference_km (synthetic)", () => {
    const [ev] = parseOpen511(eventWithLinearKm(20.63), DRIVEBC_SOURCE);
    expect(ev!.roads[0]!.milepostFrom).toBe(20.63);
  });

  it("treats -1 as a no-reference sentinel and leaves milepostFrom unset (synthetic)", () => {
    const [ev] = parseOpen511(eventWithLinearKm(-1), DRIVEBC_SOURCE);
    expect(ev!.roads[0]!.milepostFrom).toBeUndefined();
  });

  it("treats 0 as a no-reference sentinel and leaves milepostFrom unset (synthetic)", () => {
    const [ev] = parseOpen511(eventWithLinearKm(0), DRIVEBC_SOURCE);
    expect(ev!.roads[0]!.milepostFrom).toBeUndefined();
  });

  it("ignores non-finite +linear_reference_km values (synthetic)", () => {
    const [a] = parseOpen511(eventWithLinearKm("nope"), DRIVEBC_SOURCE);
    expect(a!.roads[0]!.milepostFrom).toBeUndefined();
    const [b] = parseOpen511(eventWithLinearKm(null), DRIVEBC_SOURCE);
    expect(b!.roads[0]!.milepostFrom).toBeUndefined();
  });

  it("does not throw when +linear_reference_km is set but there is no road (synthetic)", () => {
    const json = JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "INCIDENT",
          geography: { type: "Point", coordinates: [-123, 49] },
          roads: [],
          "+linear_reference_km": 12.5,
        },
      ],
    });
    expect(() => parseOpen511(json, DRIVEBC_SOURCE)).not.toThrow();
    const [ev] = parseOpen511(json, DRIVEBC_SOURCE);
    expect(ev!.roads).toEqual([]);
  });

  it("sets milepostFrom only on the first road when several are present (synthetic)", () => {
    const json = JSON.stringify({
      events: [
        {
          id: "e1",
          event_type: "INCIDENT",
          geography: { type: "Point", coordinates: [-123, 49] },
          roads: [{ name: "Hwy 1" }, { name: "Hwy 5" }],
          "+linear_reference_km": 33.3,
        },
      ],
    });
    const [ev] = parseOpen511(json, DRIVEBC_SOURCE);
    expect(ev!.roads[0]!.milepostFrom).toBe(33.3);
    expect(ev!.roads[1]!.milepostFrom).toBeUndefined();
  });

  it("extracts milepostFrom from the DriveBC fixture events that carry a real reference", () => {
    const events = parseOpen511(readFileSync(FIXTURE_PATH, "utf8"), DRIVEBC_SOURCE);
    const withMilepost = events.filter((e) => e.roads[0]?.milepostFrom != null);
    expect(withMilepost.length).toBeGreaterThan(0);
    for (const ev of withMilepost) {
      expect(ev.roads[0]!.milepostFrom!).toBeGreaterThan(0);
    }
  });
});
