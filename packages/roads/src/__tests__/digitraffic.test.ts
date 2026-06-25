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

describe("parseDigitraffic — deeper field extraction", () => {
  it("maps restriction value/unit, speed limit, roadState, schedule, secondaryPoint, description", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "s2",
            situationType: "ROAD_WORK",
            announcements: [
              {
                title: "RW",
                location: { description: "Tie 3 between A and B" },
                locationDetails: {
                  roadAddressLocation: {
                    primaryPoint: { roadName: "Vt 3", roadAddress: { road: 3 } },
                    secondaryPoint: { roadName: "Vt 3 end", roadAddress: { road: 3 } },
                  },
                },
                roadWorkPhases: [
                  {
                    severity: "LOW",
                    restrictions: [
                      { type: "SPEED_LIMIT", restriction: { quantity: 50, unit: "km/h" } },
                      { type: "SINGLE_LANE_CLOSED", restriction: { name: "x" } },
                    ],
                    workingHours: [
                      { weekday: "MONDAY", startTime: "07:00:00", endTime: "17:00:00" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.restrictions).toContainEqual({ type: "SPEED_LIMIT", value: 50, unit: "km/h" });
    expect(ev!.speedLimitKph).toBe(50);
    expect(ev!.roadState).toBe("some_lanes_closed");
    expect(ev!.schedule).toEqual([{ dayOfWeek: [1], timeStart: "07:00:00", timeEnd: "17:00:00" }]);
    expect(ev!.roads[0]!.to).toBe("Vt 3 end");
    expect(ev!.description).toBe("Tie 3 between A and B");
  });
});

describe("parseDigitraffic — regions", () => {
  it("collects distinct municipality/province from primary and secondary points", () => {
    const events = parseDigitraffic(readFileSync(FIXTURE_PATH, "utf8"), DIGITRAFFIC_SOURCE);
    const ev = events.find((e) => e.id.includes("GUID50465894"));
    expect(ev).toBeDefined();
    expect(ev!.regions).toBeDefined();
    expect(ev!.regions).toContain("Nousiainen");
    expect(ev!.regions).toContain("Varsinais-Suomi");
    // primary and secondary points repeat the same municipality/province → deduped
    expect(ev!.regions!.filter((r) => r === "Nousiainen")).toHaveLength(1);
  });

  it("includes areaLocation area names in regions", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "area1",
            situationType: "ROAD_WORK",
            announcements: [
              {
                title: "RW",
                locationDetails: {
                  areaLocation: {
                    areas: [{ name: "Uusimaa" }, { name: "Pirkanmaa" }, { name: "Uusimaa" }],
                  },
                },
                roadWorkPhases: [],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.regions).toEqual(["Uusimaa", "Pirkanmaa"]);
  });

  it("leaves regions unset when no administrative areas are present", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "noregions",
            situationType: "ROAD_WORK",
            announcements: [
              {
                title: "RW",
                locationDetails: {
                  roadAddressLocation: {
                    primaryPoint: { roadName: "Vt 9", roadAddress: { road: 9 } },
                  },
                },
                roadWorkPhases: [],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.regions).toBeUndefined();
  });
});

describe("parseDigitraffic — description from phase comments", () => {
  it("appends roadWorkPhases[].comment to the announcement comment", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "pc1",
            situationType: "ROAD_WORK",
            announcements: [
              {
                title: "RW",
                comment: "Tietyö käynnissä.",
                locationDetails: {
                  roadAddressLocation: {
                    primaryPoint: { roadName: "Vt 5", roadAddress: { road: 5 } },
                  },
                },
                roadWorkPhases: [
                  { comment: "Vaihe 1: kaista suljettu." },
                  { comment: "Vaihe 2: nopeusrajoitus." },
                ],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.description).toContain("Tietyö käynnissä.");
    expect(ev!.description).toContain("Vaihe 1: kaista suljettu.");
    expect(ev!.description).toContain("Vaihe 2: nopeusrajoitus.");
  });

  it("dedupes a phase comment identical to the announcement comment", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "pc2",
            situationType: "ROAD_WORK",
            announcements: [
              {
                title: "RW",
                comment: "Sama teksti.",
                roadWorkPhases: [{ comment: "Sama teksti." }],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.description).toBe("Sama teksti.");
  });

  it("uses only phase comments when the announcement has no comment", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "pc3",
            situationType: "ROAD_WORK",
            announcements: [
              {
                title: "RW",
                location: { description: "loc fallback" },
                roadWorkPhases: [{ comment: "Pelkkä vaihekommentti." }],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.description).toBe("Pelkkä vaihekommentti.");
  });
});

describe("parseDigitraffic — TMC / Alert-C external reference", () => {
  it("sets externalRefs.tmc from countryCode + locationTableNumber + alertC locationCode", () => {
    const events = parseDigitraffic(readFileSync(FIXTURE_PATH, "utf8"), DIGITRAFFIC_SOURCE);
    const ev = events.find((e) => e.id.includes("GUID50465894"));
    expect(ev).toBeDefined();
    expect(ev!.externalRefs?.tmc).toEqual({ country: "6", table: 17, code: 24355 });
  });

  it("omits tmc but keeps an alertc-fi external ref when no country code is present", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "noctry",
            situationType: "ROAD_WORK",
            announcements: [
              {
                title: "RW",
                location: {
                  locationTableNumber: 17,
                },
                locationDetails: {
                  roadAddressLocation: {
                    primaryPoint: {
                      roadName: "Vt 7",
                      roadAddress: { road: 7 },
                      alertCLocation: { locationCode: 12345 },
                    },
                  },
                },
                roadWorkPhases: [],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.externalRefs?.tmc).toBeUndefined();
    expect(ev!.externalRefs?.external).toEqual({ system: "alertc-fi", code: "12345" });
  });

  it("leaves externalRefs unset when neither country nor location code is present", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "noref",
            situationType: "ROAD_WORK",
            announcements: [
              {
                title: "RW",
                location: { description: "no codes" },
                roadWorkPhases: [],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.externalRefs).toBeUndefined();
  });
});

describe("parseDigitraffic — per-restriction validity window", () => {
  it("carries restriction.timeAndDuration onto that Restriction's validFrom/validTo", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "win1",
            situationType: "ROAD_WORK",
            announcements: [
              {
                title: "RW",
                roadWorkPhases: [
                  {
                    restrictions: [
                      {
                        type: "SPEED_LIMIT",
                        restriction: {
                          quantity: 60,
                          unit: "km/h",
                          timeAndDuration: {
                            startTime: "2026-07-01T06:00:00Z",
                            endTime: "2026-07-01T18:00:00Z",
                          },
                        },
                      },
                      {
                        type: "SINGLE_LANE_CLOSED",
                        restriction: { name: "no window" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.restrictions).toContainEqual({
      type: "SPEED_LIMIT",
      value: 60,
      unit: "km/h",
      validFrom: "2026-07-01T06:00:00Z",
      validTo: "2026-07-01T18:00:00Z",
    });
    expect(ev!.restrictions).toContainEqual({ type: "SINGLE_LANE_CLOSED" });
  });
});

describe("parseDigitraffic — phase-less feature fallback", () => {
  it("derives speedLimitKph from a Nopeusrajoitus announcement feature", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "pl1",
            situationType: "TRAFFIC_ANNOUNCEMENT",
            trafficAnnouncementType: "GENERAL",
            announcements: [
              {
                title: "TA",
                features: [{ name: "Nopeusrajoitus", quantity: 40, unit: "km/h" }],
                roadWorkPhases: [],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.speedLimitKph).toBe(40);
  });

  it("derives dimension restrictions from width/height/length/mass features", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [24, 60] },
          properties: {
            situationId: "pl2",
            situationType: "TRAFFIC_ANNOUNCEMENT",
            trafficAnnouncementType: "GENERAL",
            announcements: [
              {
                title: "TA",
                features: [
                  { name: "Ajoneuvon suurin sallittu leveys", quantity: 3.5, unit: "m" },
                  { name: "Ajoneuvon suurin sallittu korkeus", quantity: 4.2, unit: "m" },
                  { name: "Ajoneuvon suurin sallittu pituus", quantity: 25, unit: "m" },
                  { name: "Ajoneuvon suurin sallittu massa", quantity: 44, unit: "t" },
                ],
                roadWorkPhases: [],
              },
            ],
          },
        },
      ],
    };
    const [ev] = parseDigitraffic(JSON.stringify(fc), DIGITRAFFIC_SOURCE);
    expect(ev!.restrictions).toContainEqual({ type: "width", value: 3.5, unit: "m" });
    expect(ev!.restrictions).toContainEqual({ type: "height", value: 4.2, unit: "m" });
    expect(ev!.restrictions).toContainEqual({ type: "length", value: 25, unit: "m" });
    expect(ev!.restrictions).toContainEqual({ type: "weight", value: 44, unit: "t" });
  });

  it("does not derive feature-based restrictions when roadWorkPhases are present", () => {
    const events = parseDigitraffic(readFileSync(FIXTURE_PATH, "utf8"), DIGITRAFFIC_SOURCE);
    const rw = events.find((e) => e.id.includes("GUID50466272"));
    expect(rw).toBeDefined();
    // phase-based restriction only; no dimension restriction synthesised
    expect(rw!.restrictions).toEqual([{ type: "SINGLE_LANE_CLOSED" }]);
  });

  it("leaves speed/restrictions unset when phase-less features carry no structured data", () => {
    const events = parseDigitraffic(readFileSync(FIXTURE_PATH, "utf8"), DIGITRAFFIC_SOURCE);
    // the accident fixture has phase-less features without quantities → nothing to derive
    const acc = events.find((e) => e.id.includes("GUID_FIXTURE_ACCIDENT"));
    expect(acc).toBeDefined();
    expect(acc!.speedLimitKph).toBeUndefined();
    expect(acc!.restrictions).toBeUndefined();
  });
});
