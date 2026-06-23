import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDigitraffic } from "../digitraffic.js";
import { mapSourceType } from "../taxonomy.js";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures/digitraffic/messages.json");

const DIGITRAFFIC_SOURCE = {
  id: "digitraffic-fi",
  attribution: "Fintraffic / digitraffic.fi",
  country: "FI",
  license: "CC-BY-4.0",
  licenseUrl: "https://www.digitraffic.fi/en/road-traffic/#license",
} as const;

describe("parseDigitraffic — fixture", () => {
  it("parses at least one RoadEvent", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    expect(events.length).toBeGreaterThan(0);
  });

  it("emits sourceFormat:'digitraffic-json' on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    expect(events.every((ev) => ev.sourceFormat === "digitraffic-json")).toBe(true);
  });

  it("emits domain:'roads' on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    expect(events.every((ev) => ev.domain === "roads")).toBe(true);
  });

  it("emits kind:'event' on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    expect(events.every((ev) => ev.kind === "event")).toBe(true);
  });

  it("includes geometry on every emitted event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    for (const ev of events) {
      expect(ev.geometry).toBeDefined();
      expect(ev.geometry.type).toMatch(
        /^(Point|LineString|Polygon|MultiPoint|MultiLineString|MultiPolygon)$/
      );
    }
  });

  it("maps ROAD_WORK feature to type:'roadworks' with isPlanned:true", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    const rw = events.find((ev) => ev.type === "roadworks");
    expect(rw).toBeDefined();
    expect(rw!.isPlanned).toBe(true);
  });

  it("maps ACCIDENT_REPORT feature to type:'accident'", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    const acc = events.find((ev) => ev.id.includes("GUID_FIXTURE_ACCIDENT"));
    expect(acc).toBeDefined();
    expect(acc!.type).toBe("accident");
  });

  it("skips geometry-less features and does not include them in output", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    const noGeo = events.find((ev) => ev.id.includes("GUID_FIXTURE_NOGEO"));
    expect(noGeo).toBeUndefined();
  });

  it("prefixes event id with source id", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    expect(events.every((ev) => ev.id.startsWith("digitraffic-fi:"))).toBe(true);
  });

  it("sets headline from announcements[0].title", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    const acc = events.find((ev) => ev.id.includes("GUID_FIXTURE_ACCIDENT"));
    expect(acc).toBeDefined();
    expect(acc!.headline).toContain("Liikenneonnettomuus");
  });

  it("sets validFrom from timeAndDuration.startTime", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    const acc = events.find((ev) => ev.id.includes("GUID_FIXTURE_ACCIDENT"));
    expect(acc).toBeDefined();
    expect(acc!.validFrom).toBe("2026-06-22T09:45:00Z");
  });

  it("sets validTo from timeAndDuration.endTime when present", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    const acc = events.find((ev) => ev.id.includes("GUID_FIXTURE_ACCIDENT"));
    expect(acc).toBeDefined();
    expect(acc!.validTo).toBe("2026-06-22T12:00:00Z");
  });

  it("sets validTo to null when endTime is absent", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    const noEnd = events.find((ev) => ev.id.includes("GUID50465931"));
    expect(noEnd).toBeDefined();
    expect(noEnd!.validTo).toBeNull();
  });

  it("declares severity when a road-work phase carries it, derives it otherwise", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    expect(
      events.every((ev) => ev.severitySource === "declared" || ev.severitySource === "derived")
    ).toBe(true);
    // the fixture's road-work phase has an explicit HIGHEST severity → declared/critical
    expect(
      events.some((ev) => ev.severitySource === "declared" && ev.severity === "critical")
    ).toBe(true);
  });

  it("carries license from source descriptor via origin", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseDigitraffic(json, DIGITRAFFIC_SOURCE);
    for (const ev of events) {
      expect(ev.origin.kind).toBe("feed");
      if (ev.origin.kind === "feed") {
        expect(ev.origin.attribution.license).toBe("CC-BY-4.0");
      }
    }
  });

  it("accepts a pre-parsed object as well as a JSON string", () => {
    const obj = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const events = parseDigitraffic(obj, DIGITRAFFIC_SOURCE);
    expect(events.length).toBeGreaterThan(0);
  });

  it("never throws on empty features array", () => {
    expect(() =>
      parseDigitraffic({ type: "FeatureCollection", features: [] }, DIGITRAFFIC_SOURCE)
    ).not.toThrow();
    expect(
      parseDigitraffic({ type: "FeatureCollection", features: [] }, DIGITRAFFIC_SOURCE)
    ).toEqual([]);
  });

  it("never throws on invalid JSON string", () => {
    expect(() => parseDigitraffic("not-valid-json", DIGITRAFFIC_SOURCE)).not.toThrow();
    expect(parseDigitraffic("not-valid-json", DIGITRAFFIC_SOURCE)).toEqual([]);
  });

  it("never throws on missing features key", () => {
    expect(() => parseDigitraffic({ type: "FeatureCollection" }, DIGITRAFFIC_SOURCE)).not.toThrow();
    expect(parseDigitraffic({ type: "FeatureCollection" }, DIGITRAFFIC_SOURCE)).toEqual([]);
  });
});

describe("mapSourceType — digitraffic branch", () => {
  it("maps ROAD_WORK to roadworks/planned/isPlanned:true", () => {
    expect(mapSourceType("digitraffic", "ROAD_WORK")).toEqual({
      type: "roadworks",
      category: "planned",
      isPlanned: true,
    });
  });

  it("maps WEIGHT_RESTRICTION to dimension_restriction", () => {
    expect(mapSourceType("digitraffic", "WEIGHT_RESTRICTION")).toEqual({
      type: "dimension_restriction",
      category: "conditions",
      isPlanned: false,
    });
  });

  it("maps EXEMPTED_TRANSPORT to authority", () => {
    expect(mapSourceType("digitraffic", "EXEMPTED_TRANSPORT")).toEqual({
      type: "authority",
      category: "incident",
      isPlanned: false,
    });
  });

  it("maps ACCIDENT_REPORT to accident", () => {
    expect(mapSourceType("digitraffic", "ACCIDENT_REPORT")).toEqual({
      type: "accident",
      category: "incident",
      isPlanned: false,
    });
  });

  it("maps PRELIMINARY_ACCIDENT_REPORT to accident", () => {
    expect(mapSourceType("digitraffic", "PRELIMINARY_ACCIDENT_REPORT")).toEqual({
      type: "accident",
      category: "incident",
      isPlanned: false,
    });
  });

  it("maps unknown Digitraffic code to other", () => {
    expect(mapSourceType("digitraffic", "SOMETHING_UNKNOWN")).toEqual({
      type: "other",
      category: "conditions",
      isPlanned: false,
    });
  });
});

describe("parseDigitraffic — road extraction", () => {
  it("extracts road name and number from announcement locationDetails", () => {
    const events = parseDigitraffic(readFileSync(FIXTURE_PATH, "utf8"), DIGITRAFFIC_SOURCE);
    const withRoad = events.find((e) => e.roads.length > 0);
    expect(withRoad).toBeDefined();
    expect(withRoad!.roads[0]!.name).toBeTruthy();
    expect(withRoad!.roads[0]!.ref).toBeTruthy();
  });
});

describe("parseDigitraffic — extended fields", () => {
  it("maps roadWorkPhases severity, workTypes→subtype, restrictions, comment, direction, raw", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "s1",
            situationType: "ROAD_WORK",
            announcements: [
              {
                title: "Roadwork",
                comment: "Bridge work",
                locationDetails: {
                  roadAddressLocation: {
                    direction: "POS",
                    directionDescription: "Helsinki",
                    primaryPoint: { roadName: "Vt 4", roadAddress: { road: 4 } },
                  },
                },
                roadWorkPhases: [
                  {
                    severity: "HIGHEST",
                    workTypes: [{ type: "MAINTENANCE" }],
                    restrictions: [{ type: "SINGLE_LANE_CLOSED", restriction: { name: "x" } }],
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.severity).toBe("critical");
    expect(ev!.subtype).toBe("MAINTENANCE");
    expect(ev!.restrictions).toEqual([{ type: "SINGLE_LANE_CLOSED" }]);
    expect(ev!.description).toBe("Bridge work");
    expect(ev!.direction).toBe("Helsinki");
    expect(ev!.roads[0]!.name).toBe("Vt 4");
    expect(ev!.sourceRaw?.["situationId"]).toBe("s1");
  });
});
