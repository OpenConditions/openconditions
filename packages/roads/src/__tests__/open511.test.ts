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
      const raw = (ev as { subtype?: string }).subtype;
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
