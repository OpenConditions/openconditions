import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAutobahn } from "../autobahn.js";
import { mapSourceType } from "../taxonomy.js";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures/autobahn/warning.json");

const AUTOBAHN_SOURCE = {
  id: "autobahn-de",
  attribution: "Autobahn GmbH des Bundes",
  country: "DE",
  license: "dl-de/by-2-0",
  licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
} as const;

describe("parseAutobahn — warning fixture", () => {
  it("parses at least one RoadEvent", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    expect(events.length).toBeGreaterThan(0);
  });

  it("emits sourceFormat:'autobahn-json' and domain:'roads' on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    expect(events.every((ev) => ev.sourceFormat === "autobahn-json")).toBe(true);
    expect(events.every((ev) => ev.domain === "roads")).toBe(true);
  });

  it("emits kind:'event' on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    expect(events.every((ev) => ev.kind === "event")).toBe(true);
  });

  it("includes geometry on every emitted event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    for (const ev of events) {
      expect(ev.geometry).toBeDefined();
      expect(ev.geometry.type).toMatch(
        /^(Point|LineString|Polygon|MultiPoint|MultiLineString|MultiPolygon)$/
      );
    }
  });

  it("prefers GeoJSON geometry (LineString) over coordinate Point when both are present", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    const flowItem = events.find((ev) =>
      ev.id.includes("INRIX--vi-avl.2026-06-22_18-23-00-000_001.de0")
    );
    expect(flowItem).toBeDefined();
    expect(flowItem!.geometry.type).toBe("LineString");
  });

  it("falls back to coordinate Point when GeoJSON geometry is absent", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    const blockedItem = events.find((ev) =>
      ev.id.includes("EVA--vi-blk.2026-06-22_10-00-00-000.de1")
    );
    expect(blockedItem).toBeDefined();
    expect(blockedItem!.geometry.type).toBe("Point");
    const point = blockedItem!.geometry as { type: "Point"; coordinates: [number, number] };
    expect(point.coordinates[0]).toBeCloseTo(9.0);
    expect(point.coordinates[1]).toBeCloseTo(51.0);
  });

  it("skips items with neither geometry nor coordinate and does not throw", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    const noGeoItem = events.find((ev) => ev.id.includes("EVA--vi-nogeo"));
    expect(noGeoItem).toBeUndefined();
  });

  it("coerces string isBlocked:'true' to roadState:'closed'", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    const blockedItem = events.find((ev) =>
      ev.id.includes("EVA--vi-blk.2026-06-22_10-00-00-000.de1")
    );
    expect(blockedItem).toBeDefined();
    expect(blockedItem!.roadState).toBe("closed");
  });

  it("leaves roadState undefined when isBlocked is 'false'", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    const nonBlocked = events.find((ev) =>
      ev.id.includes("INRIX--vi-avl.2026-06-22_18-23-00-000_001.de0")
    );
    expect(nonBlocked).toBeDefined();
    expect(nonBlocked!.roadState).toBeUndefined();
  });

  it("joins description string array into a single string", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    const flowItem = events.find((ev) =>
      ev.id.includes("INRIX--vi-avl.2026-06-22_18-23-00-000_001.de0")
    );
    expect(flowItem).toBeDefined();
    expect(typeof flowItem!.description).toBe("string");
    expect(flowItem!.description).toContain("Beginn:");
    expect(flowItem!.description).toContain("Im Stillstand");
  });

  it("maps flow fields (delayTimeValue/abnormalTrafficType) to type:'congestion' category:'conditions'", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    const flowItem = events.find((ev) =>
      ev.id.includes("INRIX--vi-avl.2026-06-22_18-23-00-000_001.de0")
    );
    expect(flowItem).toBeDefined();
    expect(flowItem!.type).toBe("congestion");
    expect(flowItem!.category).toBe("conditions");
  });

  it("sets severitySource:'derived' on every event", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    expect(events.every((ev) => ev.severitySource === "derived")).toBe(true);
  });

  it("derives 'high' severity for isBlocked:'true' (roadState:'closed')", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    const blockedItem = events.find((ev) =>
      ev.id.includes("EVA--vi-blk.2026-06-22_10-00-00-000.de1")
    );
    expect(blockedItem).toBeDefined();
    expect(blockedItem!.severity).toBe("high");
  });

  it("prefixes event id with source id", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    expect(events.every((ev) => ev.id.startsWith("autobahn-de:"))).toBe(true);
  });

  it("carries license from the source descriptor via origin", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    for (const ev of events) {
      expect(ev.origin.kind).toBe("feed");
      if (ev.origin.kind === "feed") {
        expect(ev.origin.attribution.license).toBe("dl-de/by-2-0");
      }
    }
  });

  it("coerces parseable startTimestamp to ISO string", () => {
    const json = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");

    const isoItem = events.find((ev) =>
      ev.id.includes("INRIX--vi-avl.2026-06-22_18-23-00-000_001.de0")
    );
    expect(isoItem).toBeDefined();
    expect(isoItem!.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("returns null validFrom when startTimestamp is null", () => {
    const feed = {
      warning: [
        {
          identifier: "null-ts-test",
          isBlocked: "false",
          title: "Test item with null timestamp",
          startTimestamp: null,
          coordinate: { lat: 52.5, long: 13.4 },
          description: ["Test"],
        },
      ],
    };
    const events = parseAutobahn(feed, AUTOBAHN_SOURCE, "warning");
    expect(events.length).toBe(1);
    expect(events[0]!.validFrom).toBeNull();
  });

  it("accepts a pre-parsed object as well as a JSON string", () => {
    const obj = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const events = parseAutobahn(obj, AUTOBAHN_SOURCE, "warning");
    expect(events.length).toBeGreaterThan(0);
  });

  it("never throws on empty warning array", () => {
    expect(() => parseAutobahn({ warning: [] }, AUTOBAHN_SOURCE, "warning")).not.toThrow();
    expect(parseAutobahn({ warning: [] }, AUTOBAHN_SOURCE, "warning")).toEqual([]);
  });

  it("never throws on missing service key", () => {
    expect(() => parseAutobahn({}, AUTOBAHN_SOURCE, "warning")).not.toThrow();
    expect(parseAutobahn({}, AUTOBAHN_SOURCE, "warning")).toEqual([]);
  });

  it("never throws on invalid JSON string", () => {
    expect(() => parseAutobahn("not-valid-json", AUTOBAHN_SOURCE, "warning")).not.toThrow();
    expect(parseAutobahn("not-valid-json", AUTOBAHN_SOURCE, "warning")).toEqual([]);
  });
});

describe("parseAutobahn — roadworks service", () => {
  it("maps roadworks service to type:'roadworks' with isPlanned:true", () => {
    const feed = {
      roadworks: [
        {
          identifier: "rw-001",
          isBlocked: "false",
          title: "A1 | Neuhaus - Quierschied",
          startTimestamp: "2026-06-23T08:30:00Z",
          coordinate: { lat: 49.31, long: 6.97 },
          description: ["Baustelle"],
        },
      ],
    };
    const events = parseAutobahn(feed, AUTOBAHN_SOURCE, "roadworks");
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("roadworks");
    expect(events[0]!.isPlanned).toBe(true);
  });
});

describe("mapSourceType — autobahn branch", () => {
  it("maps autobahn roadworks to roadworks/planned/isPlanned:true", () => {
    expect(mapSourceType("autobahn", "roadworks")).toEqual({
      type: "roadworks",
      category: "planned",
      isPlanned: true,
    });
  });

  it("maps autobahn closure to road_closure/incident/isPlanned:false", () => {
    expect(mapSourceType("autobahn", "closure")).toEqual({
      type: "road_closure",
      category: "incident",
      isPlanned: false,
    });
  });

  it("maps autobahn warning to hazard/conditions/isPlanned:false", () => {
    expect(mapSourceType("autobahn", "warning")).toEqual({
      type: "hazard",
      category: "conditions",
      isPlanned: false,
    });
  });

  it("maps unknown autobahn service to other", () => {
    expect(mapSourceType("autobahn", "unknown-service")).toEqual({
      type: "other",
      category: "conditions",
      isPlanned: false,
    });
  });
});

describe("parseAutobahn — road extraction from title", () => {
  it("extracts the autobahn designation from the title into roads[]", () => {
    const events = parseAutobahn(readFileSync(FIXTURE_PATH, "utf8"), AUTOBAHN_SOURCE, "warning");
    const withRoad = events.find((e) => e.roads.length > 0);
    expect(withRoad).toBeDefined();
    expect(withRoad!.roads[0]!.ref).toMatch(/^A\d/);
  });

  it("parses the road from a synthetic 'A3 | segment' title", () => {
    const json = JSON.stringify({
      warning: [
        {
          identifier: "w1",
          title: "A3 | Köln-Ost - Leverkusen",
          subtitle: "Köln -> Leverkusen",
          coordinate: { lat: "50.9", long: "7.0" },
        },
      ],
    });
    const [ev] = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");
    expect(ev!.roads[0]).toEqual({ name: "A3", ref: "A3" });
  });
});
