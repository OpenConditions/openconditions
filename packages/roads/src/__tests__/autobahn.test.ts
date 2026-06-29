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

describe("parseAutobahn — extended fields", () => {
  it("maps routeRecommendation→detour, future→isForecast, and preserves the raw item", () => {
    const json = JSON.stringify({
      warning: [
        {
          identifier: "w9",
          title: "A8 | München-Ost",
          future: true,
          routeRecommendation: ["Use A99"],
          coordinate: { lat: "48.1", long: "11.5" },
        },
      ],
    });
    const [ev] = parseAutobahn(json, AUTOBAHN_SOURCE, "warning");
    expect(ev!.detour).toBe("Use A99");
    expect(ev!.isForecast).toBe(true);
    expect(ev!.sourceRaw?.["identifier"]).toBe("w9");
  });
});

describe("parseAutobahn — delaySeconds from congestion delayTimeValue", () => {
  it("converts the minute-valued delayTimeValue to delaySeconds on the congestion path", () => {
    const events = parseAutobahn(readFileSync(FIXTURE_PATH, "utf8"), AUTOBAHN_SOURCE, "warning");
    const flowItem = events.find((ev) =>
      ev.id.includes("INRIX--vi-avl.2026-06-22_18-23-00-000_001.de0")
    );
    expect(flowItem).toBeDefined();
    expect(flowItem!.type).toBe("congestion");
    expect(flowItem!.delaySeconds).toBe(18 * 60);
  });

  it("leaves delaySeconds undefined when delayTimeValue is absent", () => {
    const feed = {
      warning: [
        {
          identifier: "no-delay",
          title: "A1 | Test",
          averageSpeed: "20",
          coordinate: { lat: 50.0, long: 7.0 },
          description: ["Stau"],
        },
      ],
    };
    const [ev] = parseAutobahn(feed, AUTOBAHN_SOURCE, "warning");
    expect(ev!.type).toBe("congestion");
    expect(ev!.delaySeconds).toBeUndefined();
  });

  it("ignores non-finite or non-positive delayTimeValue", () => {
    const feed = {
      warning: [
        {
          identifier: "bad-delay",
          title: "A1 | Test",
          delayTimeValue: "n/a",
          coordinate: { lat: 50.0, long: 7.0 },
          description: ["Stau"],
        },
        {
          identifier: "zero-delay",
          title: "A2 | Test",
          delayTimeValue: "0",
          coordinate: { lat: 51.0, long: 8.0 },
          description: ["Stau"],
        },
      ],
    };
    const events = parseAutobahn(feed, AUTOBAHN_SOURCE, "warning");
    const bad = events.find((ev) => ev.id.includes("bad-delay"));
    const zero = events.find((ev) => ev.id.includes("zero-delay"));
    expect(bad!.delaySeconds).toBeUndefined();
    expect(zero!.delaySeconds).toBeUndefined();
  });
});

describe("parseAutobahn — structured validity (Europe/Berlin)", () => {
  it("parses 'Ende: DD.MM.YY um HH:MM Uhr' into validTo as a Berlin-local instant (CEST → -02:00)", () => {
    const feed = {
      warning: [
        {
          identifier: "ende-test",
          title: "A4 | Köln - Aachen",
          coordinate: { lat: 50.8, long: 6.5 },
          description: [
            "Baustelle",
            "Beginn: 22.06.26 um 08:00 Uhr",
            "Ende: 06.07.26 um 05:00 Uhr",
          ],
        },
      ],
    };
    const [ev] = parseAutobahn(feed, AUTOBAHN_SOURCE, "warning");
    // 06.07.26 05:00 CEST == 03:00Z (not 05:00Z).
    expect(ev!.validTo).toBe("2026-07-06T03:00:00.000Z");
    expect(ev!.schedule).toBeUndefined();
  });

  it("prefers structured startTimestamp for validFrom, falling back to 'Beginn:' prose (Berlin)", () => {
    const feed = {
      warning: [
        {
          identifier: "start-structured",
          title: "A4 | Köln - Aachen",
          coordinate: { lat: 50.8, long: 6.5 },
          startTimestamp: "2026-07-10T22:00:00+02:00",
          description: ["Beginn: 10.07.26 um 22:00 Uhr"],
        },
        {
          identifier: "start-prose-only",
          title: "A3 | Köln - Frankfurt",
          coordinate: { lat: 50.6, long: 7.2 },
          description: ["Beginn: 22.06.26 um 08:00 Uhr"],
        },
      ],
    };
    const events = parseAutobahn(feed, AUTOBAHN_SOURCE, "warning");
    const structured = events.find((e) => e.id.includes("start-structured"));
    const prose = events.find((e) => e.id.includes("start-prose-only"));
    expect(structured!.validFrom).toBe("2026-07-10T20:00:00.000Z");
    // 22.06.26 08:00 CEST == 06:00Z.
    expect(prose!.validFrom).toBe("2026-06-22T06:00:00.000Z");
  });

  it("collapses a recurring nightly closure list into a schedule window + outer bounds", () => {
    const feed = {
      closure: [
        {
          identifier: "nightly",
          title: "A4 | Köln-Merheim - Untereschbach",
          coordinate: { lat: 50.95, long: 7.1 },
          description: [
            "Die Baustelle ist zu folgenden Zeiträumen gültig:",
            "29.06.26 20:00 bis zum 30.06.26 05:00 Uhr.",
            "30.06.26 20:00 bis zum 01.07.26 05:00 Uhr.",
            "01.07.26 20:00 bis zum 02.07.26 05:00 Uhr.",
            "(Ende der Gesamtmaßnahme: 10.07.26)",
          ],
        },
      ],
    };
    const [ev] = parseAutobahn(feed, AUTOBAHN_SOURCE, "closure");
    // One recurrence window: nightly 20:00–05:00 over the start-date span.
    expect(ev!.schedule).toEqual([
      { dateStart: "2026-06-29", dateEnd: "2026-07-01", timeStart: "20:00", timeEnd: "05:00" },
    ]);
    // Outer bounds: first window start … last window end (Berlin → UTC).
    expect(ev!.validFrom).toBe("2026-06-29T18:00:00.000Z");
    expect(ev!.validTo).toBe("2026-07-02T03:00:00.000Z");
  });

  it("leaves validTo null and schedule unset when no end-time prose is present", () => {
    const feed = {
      warning: [
        {
          identifier: "no-ende",
          title: "A4 | Köln - Aachen",
          coordinate: { lat: 50.8, long: 6.5 },
          description: ["Baustelle", "Beginn: 22.06.26 um 08:00 Uhr"],
        },
      ],
    };
    const [ev] = parseAutobahn(feed, AUTOBAHN_SOURCE, "warning");
    expect(ev!.validTo).toBeNull();
    expect(ev!.schedule).toBeUndefined();
  });
});

describe("parseAutobahn — restrictions from prose", () => {
  it("parses 'Durchfahrtsbreite: N m' into a width restriction (dot decimal)", () => {
    const feed = {
      warning: [
        {
          identifier: "width-dot",
          title: "A4 | Köln - Aachen",
          coordinate: { lat: 50.8, long: 6.5 },
          description: ["Baustelle", "Durchfahrtsbreite: 3.25 m"],
        },
      ],
    };
    const [ev] = parseAutobahn(feed, AUTOBAHN_SOURCE, "warning");
    expect(ev!.restrictions).toEqual([{ type: "width", value: 3.25, unit: "m" }]);
  });

  it("parses width with a comma decimal", () => {
    const feed = {
      warning: [
        {
          identifier: "width-comma",
          title: "A4 | Köln - Aachen",
          coordinate: { lat: 50.8, long: 6.5 },
          description: ["Durchfahrtsbreite: 2,75 m"],
        },
      ],
    };
    const [ev] = parseAutobahn(feed, AUTOBAHN_SOURCE, "warning");
    expect(ev!.restrictions).toEqual([{ type: "width", value: 2.75, unit: "m" }]);
  });

  it("parses 'Durchfahrtshöhe' (and the 'Durchfahrtshoehe' spelling) into a height restriction", () => {
    const umlaut = {
      warning: [
        {
          identifier: "height-umlaut",
          title: "A4 | Köln - Aachen",
          coordinate: { lat: 50.8, long: 6.5 },
          description: ["Durchfahrtshöhe: 3,8 m"],
        },
      ],
    };
    const ascii = {
      warning: [
        {
          identifier: "height-ascii",
          title: "A4 | Köln - Aachen",
          coordinate: { lat: 50.8, long: 6.5 },
          description: ["Durchfahrtshoehe: 4.0 m"],
        },
      ],
    };
    const [umlautEv] = parseAutobahn(umlaut, AUTOBAHN_SOURCE, "warning");
    const [asciiEv] = parseAutobahn(ascii, AUTOBAHN_SOURCE, "warning");
    expect(umlautEv!.restrictions).toEqual([{ type: "height", value: 3.8, unit: "m" }]);
    expect(asciiEv!.restrictions).toEqual([{ type: "height", value: 4.0, unit: "m" }]);
  });

  it("emits both width and height restrictions when both are present", () => {
    const feed = {
      warning: [
        {
          identifier: "width-and-height",
          title: "A4 | Köln - Aachen",
          coordinate: { lat: 50.8, long: 6.5 },
          description: ["Durchfahrtsbreite: 3.0 m", "Durchfahrtshöhe: 3,5 m"],
        },
      ],
    };
    const [ev] = parseAutobahn(feed, AUTOBAHN_SOURCE, "warning");
    expect(ev!.restrictions).toEqual([
      { type: "width", value: 3.0, unit: "m" },
      { type: "height", value: 3.5, unit: "m" },
    ]);
  });

  it("leaves restrictions undefined when no dimension prose is present", () => {
    const feed = {
      warning: [
        {
          identifier: "no-restriction",
          title: "A4 | Köln - Aachen",
          coordinate: { lat: 50.8, long: 6.5 },
          description: ["Baustelle"],
        },
      ],
    };
    const [ev] = parseAutobahn(feed, AUTOBAHN_SOURCE, "warning");
    expect(ev!.restrictions).toBeUndefined();
  });
});
