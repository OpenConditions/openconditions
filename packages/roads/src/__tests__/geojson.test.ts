import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { feedToSourceDescriptor } from "../feeds.js";
import { parseGeoJson } from "../geojson.js";
import type { SourceDescriptor } from "../types.js";
import { testFeed } from "./helpers/test-feeds.js";

const SRC: SourceDescriptor = {
  id: "test-gj",
  attribution: "Test GeoJSON",
  country: "AU",
  license: "CC-BY-4.0",
  geojson: {
    idField: "id",
    typeField: "category",
    typeMap: { Crash: "incident.accident.multi_vehicle", roadworks: "roadworks" },
    headlineField: "headline",
    descriptionField: "info",
    severityField: "priority",
    severityMap: { high: "high", low: "low" },
    roadField: "road",
    updatedField: "updated",
  },
};

function fc(features: unknown[]): string {
  return JSON.stringify({ type: "FeatureCollection", features });
}

describe("parseGeoJson", () => {
  it("maps a feature through the field mapping and the feed's typeMap", () => {
    const out = parseGeoJson(
      fc([
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [151.2, -33.8] },
          properties: {
            id: "X1",
            category: "Crash",
            headline: "Crash on M1",
            info: "Two vehicles",
            priority: "high",
            road: "M1",
            updated: "2026-06-25T10:00:00Z",
          },
        },
      ]),
      SRC,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "test-gj:X1",
      source: "test-gj",
      sourceFormat: "geojson",
      // A situation-code entry is the classification; the coarse type follows from it.
      type: "accident",
      category: "incident",
      situation: {
        classification: { kind: "incident", type: "accident", subtype: "multi_vehicle" },
      },
      severity: "high",
      headline: "Crash on M1",
      description: "Two vehicles",
      dataUpdatedAt: "2026-06-25T10:00:00.000Z",
    });
    expect(out[0]!.geometry).toEqual({ type: "Point", coordinates: [151.2, -33.8] });
    expect(out[0]!.roads).toEqual([{ name: "M1" }]);
    // Lossless passthrough.
    expect((out[0]!.sourceRaw as { id: string }).id).toBe("X1");
  });

  it("uses defaultType for feeds without a per-feature type (e.g. closures-only)", () => {
    const out = parseGeoJson(
      fc([
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
          properties: { id: "c1" },
        },
      ]),
      { ...SRC, geojson: { idField: "id", defaultType: "road_closure" } },
    );
    expect(out[0]!.type).toBe("road_closure");
    expect(out[0]!.category).toBe("incident");
  });

  it("skips features with null/absent geometry", () => {
    const out = parseGeoJson(
      fc([
        { type: "Feature", geometry: null, properties: { id: "n" } },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { id: "y", category: "roadworks" },
        },
      ]),
      SRC,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("test-gj:y");
  });

  it("falls back to the feature index when no id field is present", () => {
    const out = parseGeoJson(
      fc([{ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: {} }]),
      { ...SRC, geojson: { typeField: "category" } },
    );
    expect(out[0]!.id).toBe("test-gj:0");
    expect(out[0]!.type).toBe("other");
  });

  it("identifies a record by its idFields when the publisher renumbers it on every refresh", () => {
    const src = { ...SRC, geojson: { idFields: ["road", "start"], headlineField: "headline" } };
    const record = (oid: number, road: string, headline: string) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [138.6, -34.9] },
      properties: { OID: oid, road, start: 1784527200000, headline },
    });
    const before = parseGeoJson(
      fc([record(1, "A1", "Works"), record(2, "B2", "Closure"), record(3, "C3", "Lane shift")]),
      src,
    );
    // Rebuilt: every record renumbered and listed in another order.
    const after = parseGeoJson(
      fc([record(9, "C3", "Lane shift"), record(7, "A1", "Works"), record(8, "B2", "Closure")]),
      src,
    );
    const ids = (events: typeof before) => new Map(events.map((e) => [e.headline, e.id]));
    expect(ids(after)).toEqual(ids(before));
    expect(new Set(before.map((e) => e.id)).size).toBe(3);
    expect(before[0]!.id).toMatch(/^test-gj:[0-9a-f]{16}$/);
  });

  it("accepts a GeometryCollection feature (Berlin VIZ mixes Point+LineString)", () => {
    const out = parseGeoJson(
      fc([
        {
          type: "Feature",
          geometry: {
            type: "GeometryCollection",
            geometries: [
              { type: "Point", coordinates: [13.3, 52.5] },
              {
                type: "LineString",
                coordinates: [
                  [13.3, 52.5],
                  [13.31, 52.51],
                ],
              },
            ],
          },
          properties: { id: "g1", category: "roadworks" },
        },
      ]),
      SRC,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.geometry!.type).toBe("GeometryCollection");
    expect(out[0]!.type).toBe("roadworks");
  });

  it("reprojects EPSG:3857 (Web Mercator) coordinates to WGS84", () => {
    const out = parseGeoJson(
      JSON.stringify({
        type: "FeatureCollection",
        crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3857" } },
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-8338879.6, 5772014.3] },
            properties: { id: "m1", category: "roadworks" },
          },
        ],
      }),
      SRC,
    );
    const g = out[0]!.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    // ~Québec: lon ≈ -74.9, lat ≈ 45.9 (not the raw metre values).
    expect(g.coordinates[0]!).toBeGreaterThan(-80);
    expect(g.coordinates[0]!).toBeLessThan(-70);
    expect(g.coordinates[1]!).toBeGreaterThan(44);
    expect(g.coordinates[1]!).toBeLessThan(48);
  });

  it("builds Point geometry from lonField/latField when set (national-grid geometry)", () => {
    const out = parseGeoJson(
      JSON.stringify({
        type: "FeatureCollection",
        crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3057" } },
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [335406, 508994] }, // EPSG:3057 metres
            properties: { kind: "roadworks", X: -22.49, Y: 65.04 },
          },
        ],
      }),
      { ...SRC, geojson: { lonField: "X", latField: "Y", typeField: "kind" } },
    );
    // Uses the WGS84 X/Y, not the raw 3057 geometry.
    expect(out[0]!.geometry).toEqual({ type: "Point", coordinates: [-22.49, 65.04] });
  });

  it("returns [] for malformed JSON or a non-FeatureCollection", () => {
    expect(parseGeoJson("not json", SRC)).toEqual([]);
    expect(parseGeoJson(JSON.stringify({ type: "Feature" }), SRC)).toEqual([]);
  });

  it("accepts a Buffer and reads a dotted properties path", () => {
    const buf = Buffer.from(
      fc([
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { meta: { kind: "roadworks" } },
        },
      ]),
      "utf8",
    );
    const out = parseGeoJson(buf, {
      ...SRC,
      geojson: { typeField: "meta.kind", typeMap: { roadworks: "roadworks" } },
    });
    expect(out[0]!.type).toBe("roadworks");
  });
});

describe("parseGeoJson — NZTA Road Events fixture (real wired mapping)", () => {
  it("parses the live ArcGIS GeoJSON via the registered nzta-nz mapping", () => {
    const feed = testFeed("nz-nzta-events");
    const xml = readFileSync(join(import.meta.dirname, "fixtures/nzta-nz/road-events.geojson"));
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.geometry != null)).toBe(true);
    // WGS84 NZ coordinates (lon ~166..179, lat ~ -47..-34).
    const pt = events.find((e) => e.geometry?.type === "Point")!;
    const g = pt.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    expect(g.coordinates[0]!).toBeGreaterThan(160);
    expect(g.coordinates[1]!).toBeLessThan(-30);
    // The source vocabulary maps through the per-feed typeMap (no raw "Crash" leak).
    expect(events.every((e) => e.type !== ("Crash" as unknown))).toBe(true);
    expect(events[0]!.sourceFormat).toBe("geojson");
  });
});

describe("parseGeoJson — Berlin VIZ fixture (GeometryCollection + German vocab)", () => {
  it("parses mixed GeometryCollection/Point features via the registered berlin-de mapping", () => {
    const feed = testFeed("de-be-berlin-events");
    const xml = readFileSync(join(import.meta.dirname, "fixtures/berlin-de/baustellen.geojson"));
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.geometry != null)).toBe(true);
    // German subtype vocab maps via the per-feed typeMap (not all "other").
    expect(events.some((e) => e.type === "roadworks" || e.type === "road_closure")).toBe(true);
    // At least one GeometryCollection survived (the bug fix).
    expect(events.some((e) => e.geometry?.type === "GeometryCollection")).toBe(true);
  });
});

describe("parseGeoJson — MTQ Québec fixture (EPSG:3857 reprojection)", () => {
  it("reprojects the WFS Web-Mercator output to WGS84 via the registered mtq-qc mapping", () => {
    const feed = testFeed("ca-qc-mtq-events");
    const xml = readFileSync(join(import.meta.dirname, "fixtures/mtq-qc/chantiers.geojson"));
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === "roadworks")).toBe(true);
    // Coordinates land in Québec lon/lat, not raw 3857 metres.
    const ls = events.find((e) => e.geometry?.type === "LineString")!;
    const g = ls.geometry;
    if (!g || g.type !== "LineString") throw new Error("expected LineString");
    const [lon, lat] = g.coordinates[0]!;
    expect(lon!).toBeGreaterThan(-80);
    expect(lon!).toBeLessThan(-57);
    expect(lat!).toBeGreaterThan(44);
    expect(lat!).toBeLessThan(63);
  });

  it("carries the chantier's debut/fin into the validity window", () => {
    const feed = testFeed("ca-qc-mtq-events");
    const xml = readFileSync(join(import.meta.dirname, "fixtures/mtq-qc/chantiers.geojson"));
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    const ev = events.find((e) => e.id === "ca-qc-mtq-events:164507");
    expect(ev).toBeDefined();
    // MTQ publishes zone-less local times, read here in the server's zone, so
    // assert the calendar day rather than an exact instant.
    expect(ev!.validFrom).toMatch(/^2026-02-09T/);
    expect(ev!.validTo).toMatch(/^2026-09-18T/);
  });
});

describe("parseGeoJson — Brussels fixture (per-geometry EPSG:3812 reprojection)", () => {
  it("reprojects Lambert-2008 per-geometry coords to WGS84 via the registered mapping", () => {
    const feed = testFeed("be-brussels-events");
    const xml = readFileSync(
      join(import.meta.dirname, "fixtures/brussels-be/traffic_events.geojson"),
    );
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    expect(events.length).toBeGreaterThan(0);
    const g = events[0]!.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    // Brussels WGS84, and the stale per-geometry crs member is dropped.
    expect(g.coordinates[0]!).toBeGreaterThan(3.9);
    expect(g.coordinates[0]!).toBeLessThan(4.6);
    expect(g.coordinates[1]!).toBeGreaterThan(50.7);
    expect(g.coordinates[1]!).toBeLessThan(51);
    expect("crs" in g).toBe(false);
  });
});

describe("parseGeoJson — Vegagerðin Iceland fixture (lon/lat from properties)", () => {
  it("uses the WGS84 X/Y fields, not the EPSG:3057 geometry, via the registered mapping", () => {
    const feed = testFeed("is-vegagerdin-conditions");
    const xml = readFileSync(
      join(import.meta.dirname, "fixtures/vegagerdin-is/pointincident.geojson"),
    );
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    expect(events.length).toBeGreaterThan(0);
    const g = events[0]!.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    // Iceland WGS84 bounds (lon ~ -25..-13, lat ~ 63..67), not 3057 metres.
    expect(g.coordinates[0]!).toBeGreaterThan(-25);
    expect(g.coordinates[0]!).toBeLessThan(-13);
    expect(g.coordinates[1]!).toBeGreaterThan(63);
    expect(g.coordinates[1]!).toBeLessThan(67);
  });
});

describe("parseGeoJson — Traffic SA fixture (ArcGIS f=geojson, real mapping)", () => {
  it("parses South Australia incidents/roadworks via the registered trafficsa-au mapping", () => {
    const feed = testFeed("au-sa-trafficsa-events");
    const xml = readFileSync(join(import.meta.dirname, "fixtures/trafficsa-au/events.geojson"));
    const events = parseGeoJson(xml, feedToSourceDescriptor(feed));
    expect(events.length).toBeGreaterThan(0);
    const g = events[0]!.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    // South Australia WGS84 bbox.
    expect(g.coordinates[0]!).toBeGreaterThan(129);
    expect(g.coordinates[0]!).toBeLessThan(141);
    expect(g.coordinates[1]!).toBeLessThan(-26);
    expect(events.some((e) => e.type === "roadworks")).toBe(true);
  });
});

describe("parseGeoJson — Polizei Hamburg fixture (api.hamburg.de OGC API, real mapping)", () => {
  it("maps the `art` DATEX classes through the registered de-hh-polizei-events typeMap", () => {
    const feed = testFeed("de-hh-polizei-events");
    const json = readFileSync(
      join(import.meta.dirname, "fixtures/polizei-hamburg-de/hauptmeldungen.geojson"),
    );
    const events = parseGeoJson(json, feedToSourceDescriptor(feed));
    expect(events).toHaveLength(5);

    const byType = (t: string) => events.filter((e) => e.type === t);
    expect(byType("congestion")).toHaveLength(1); // AbnormalTraffic
    expect(byType("accident")).toHaveLength(1); // Accident
    expect(byType("lane_closure")).toHaveLength(1); // RoadOrCarriagewayOrLaneManagement
    expect(byType("roadworks")).toHaveLength(2); // ConstructionWorks + MaintenanceWorks
    expect(byType("roadworks").map((e) => e.situation?.classification?.subtype)).toEqual(
      expect.arrayContaining(["construction", "maintenance"]),
    );

    const congestion = byType("congestion")[0]!;
    expect(congestion.id).toBe("de-hh-polizei-events:LMS/r_LMS/699889_LMS-TH/58.0");
    expect(congestion.subtype).toBe("AbnormalTraffic");
    expect(congestion.description).toContain("Steilshooper Allee");
    expect(congestion.origin.attribution).toMatchObject({
      provider: "Freie und Hansestadt Hamburg, Polizei Hamburg",
      license: "DL-DE-BY-2.0",
    });

    // Geometry is taken verbatim as WGS84 (OGC API default CRS84) — Hamburg bbox.
    const g = congestion.geometry;
    if (!g || g.type !== "Point") throw new Error("expected Point");
    expect(g.coordinates[0]!).toBeGreaterThan(9.7);
    expect(g.coordinates[0]!).toBeLessThan(10.4);
    expect(g.coordinates[1]!).toBeGreaterThan(53.3);
    expect(g.coordinates[1]!).toBeLessThan(53.8);
  });
});

describe("parseGeoJson — validity dates", () => {
  const DATED: SourceDescriptor = {
    ...SRC,
    geojson: { idField: "id", validFromField: "debut", validToField: "fin" },
  };
  const point = (props: Record<string, unknown>) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [1, 2] },
    properties: props,
  });

  it("reads epoch-seconds validity into validFrom/validTo", () => {
    const [ev] = parseGeoJson(fc([point({ id: "a", debut: 1680840000, fin: 1782792000 })]), DATED);
    expect(ev!.validFrom).toBe(new Date(1680840000 * 1000).toISOString());
    expect(ev!.validTo).toBe(new Date(1782792000 * 1000).toISOString());
  });

  it("reads a parseable date string into validFrom/validTo", () => {
    const [ev] = parseGeoJson(
      fc([point({ id: "b", debut: "2026-02-09T06:30:00Z", fin: "2026-03-01T18:00:00Z" })]),
      DATED,
    );
    expect(ev!.validFrom).toBe("2026-02-09T06:30:00.000Z");
    expect(ev!.validTo).toBe("2026-03-01T18:00:00.000Z");
  });

  it("emits null for an unparseable or missing validity value", () => {
    const [ev] = parseGeoJson(fc([point({ id: "c", debut: "not a date" })]), DATED);
    expect(ev!.validFrom).toBeNull();
    expect(ev!.validTo).toBeNull();
  });

  describe("days and local times", () => {
    const DATES: SourceDescriptor = { ...DATED, timeZone: "Europe/Berlin" };
    const MIDNIGHTS: SourceDescriptor = {
      ...DATES,
      geojson: { ...DATED.geojson, validityDaysAtMidnight: true },
    };

    it("reads a date alone as its whole day in the feed's zone, in every feed", () => {
      // GeoServer's xsd:date form; 1 November is after the change to CET.
      const [ev] = parseGeoJson(
        fc([point({ id: "e", debut: "2026-10-05Z", fin: "2026-11-01Z" })]),
        DATES,
      );
      expect(ev!.validFrom).toBe("2026-10-04T22:00:00.000Z");
      expect(ev!.validTo).toBe("2026-11-01T23:00:00.000Z");
      const [dotted] = parseGeoJson(
        fc([point({ id: "j", debut: "05.10.2026", fin: "1.11.2026" })]),
        DATES,
      );
      expect([dotted!.validFrom, dotted!.validTo]).toEqual([ev!.validFrom, ev!.validTo]);
    });

    it("ends a record dated to the last day of a year on the next day", () => {
      const [ev] = parseGeoJson(
        fc([point({ id: "f", debut: "2026-12-31", fin: "2026-12-31" })]),
        DATED,
      );
      expect(ev!.validFrom).toBe("2026-12-31T00:00:00.000Z");
      expect(ev!.validTo).toBe("2027-01-01T00:00:00.000Z");
    });

    it("reads a value with a time of day as an instant", () => {
      const [ev] = parseGeoJson(
        fc([point({ id: "g", debut: "2026-10-05T10:00:00Z", fin: "2026-11-01T11:00:00Z" })]),
        MIDNIGHTS,
      );
      expect(ev!.validFrom).toBe("2026-10-05T10:00:00.000Z");
      expect(ev!.validTo).toBe("2026-11-01T11:00:00.000Z");
    });

    it("reads midnights and epochs at midnight UTC as days only with validityDaysAtMidnight", () => {
      const midnight = Date.UTC(2026, 10, 1);
      const values = { debut: "2026-09-21T00:00:00.000", fin: midnight };
      const [days] = parseGeoJson(fc([point({ id: "k", ...values })]), MIDNIGHTS);
      expect(days!.validFrom).toBe("2026-09-20T22:00:00.000Z");
      expect(days!.validTo).toBe("2026-11-01T23:00:00.000Z");
      const [instants] = parseGeoJson(fc([point({ id: "l", ...values })]), DATES);
      expect(instants!.validFrom).toBe("2026-09-20T22:00:00.000Z");
      expect(instants!.validTo).toBe("2026-11-01T00:00:00.000Z");
      const [later] = parseGeoJson(fc([point({ id: "m", fin: midnight + 3_600_000 })]), MIDNIGHTS);
      expect(later!.validTo).toBe("2026-11-01T01:00:00.000Z");
    });

    it("reads a feed's local times marked UTC as local, its updates too", () => {
      const marked: SourceDescriptor = {
        ...DATES,
        localTimesMarkedUtc: true,
        geojson: { ...DATED.geojson, updatedField: "stand" },
      };
      const [ev] = parseGeoJson(
        fc([
          point({
            id: "p",
            debut: "2026-11-21T09:00:00Z",
            fin: "2026-11-21T13:00:00Z",
            stand: "2026-11-20T15:30:00Z",
          }),
        ]),
        marked,
      );
      expect(ev!.validFrom).toBe("2026-11-21T08:00:00.000Z");
      expect(ev!.validTo).toBe("2026-11-21T12:00:00.000Z");
      expect(ev!.situation?.sourceUpdatedAt).toBe("2026-11-20T14:30:00.000Z");
    });

    it("reads both ends from a range field, two-digit years of this century", () => {
      const ranged: SourceDescriptor = {
        ...DATES,
        geojson: { idField: "id", validityRangeField: "zeit" },
      };
      const [ev] = parseGeoJson(fc([point({ id: "n", zeit: "13.04.26 - 30.10.26" })]), ranged);
      expect(ev!.validFrom).toBe("2026-04-12T22:00:00.000Z");
      expect(ev!.validTo).toBe("2026-10-30T23:00:00.000Z");
      const [open] = parseGeoJson(fc([point({ id: "o", zeit: "ab sofort" })]), ranged);
      expect(open!.validFrom).toBeNull();
      expect(open!.validTo).toBeNull();
    });

    it("emits null for a day the month does not have", () => {
      const [ev] = parseGeoJson(fc([point({ id: "h", debut: "2026-02-30Z" })]), DATES);
      expect(ev!.validFrom).toBeNull();
    });
  });

  it("leaves validity unset when the mapping declares no date fields", () => {
    const [ev] = parseGeoJson(fc([point({ id: "d", debut: 1680840000 })]), SRC);
    expect(ev!.validFrom).toBeUndefined();
    expect(ev!.validTo).toBeUndefined();
  });
});

describe("parseGeoJson — follow-ups", () => {
  const FOLLOW_UPS: SourceDescriptor = {
    ...SRC,
    timeZone: "Asia/Bangkok",
    geojson: {
      idField: "id",
      descriptionField: "text",
      updatedField: "start",
      followUp: { field: "title", prefixes: ["คืบหน้า"] },
    },
  };
  const record = (id: string, title: string, start: string, text: string) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [100.96647, 13.86298] },
    properties: { id, title, start, text },
  });
  const original = record("1", "อุบัติเหตุ", "2026-06-26 01:17:46", "Accident blocking lanes");
  const progress = record("3", "คืบหน้าอุบัติเหตุ", "2026-06-26 01:21:48", "Car was moved");

  it("keeps only the follow-up of an incident whose text it rewrote", () => {
    expect(parseGeoJson(fc([original, progress]), FOLLOW_UPS).map((e) => e.id)).toEqual([
      "test-gj:3",
    ]);
  });

  it("keeps both records when the feed declares no follow-ups", () => {
    const { followUp: _, ...mapping } = FOLLOW_UPS.geojson!;
    expect(
      parseGeoJson(fc([original, progress]), { ...FOLLOW_UPS, geojson: mapping }),
    ).toHaveLength(2);
  });
});

describe("parseGeoJson — free-text severity and filters", () => {
  const at = (id: string, art: string, i: number) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [7.46 + i / 100, 51.51] },
    properties: { id, art },
  });
  const src: SourceDescriptor = {
    ...SRC,
    geojson: {
      idField: "id",
      severityField: "art",
      severityMap: { "Gehweg // Vollsperrung": "low" },
      severityPatterns: [
        { match: "//\\s*Vollsperrung", severity: "high" },
        { match: "halbseitige sperrung", severity: "medium" },
      ],
      filter: [{ field: "art", excludeMatching: ["^Umzug\\b"] }],
    },
  };

  it("takes the map's entry first, then the first pattern that matches", () => {
    const out = parseGeoJson(
      fc([
        at("a", "Hofgerichtsweg - Sondierung // Vollsperrung", 0),
        at("b", "Spreestraße // Halbseitige Sperrung", 1),
        at("c", "Gehweg // Vollsperrung", 2),
        at("d", "Großholthauser Str. - Glasfaser", 3),
      ]),
      src,
    );
    expect(out.map((e) => [e.id, e.severity])).toEqual([
      ["test-gj:a", "high"],
      ["test-gj:b", "medium"],
      ["test-gj:c", "low"],
      ["test-gj:d", "unknown"],
    ]);
  });

  it("drops records whose value matches an excluding pattern", () => {
    expect(parseGeoJson(fc([at("e", "Umzug Hausnr. 5", 4)]), src)).toEqual([]);
  });
});

describe("parseGeoJson — placeholders and parts", () => {
  const line = (props: Record<string, unknown>, coordinates: number[][]) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties: props,
  });

  it("reads a feed's placeholder values as absent, keeping them in the raw record", () => {
    const src: SourceDescriptor = {
      ...SRC,
      geojson: {
        idField: "id",
        descriptionField: "text",
        roadField: "street",
        nullValues: ["null", "keine Meldung"],
      },
    };
    const [ev] = parseGeoJson(
      fc([
        line({ id: "a", text: "keine Meldung", street: " null" }, [
          [12.3, 51.3],
          [12.31, 51.3],
        ]),
      ]),
      src,
    );
    expect(ev!.description).toBeUndefined();
    expect(ev!.roads).toEqual([]);
    expect(ev!.sourceRaw).toMatchObject({ text: "keine Meldung" });
  });

  it("joins the parts a feed exports under one id into one event", () => {
    const src: SourceDescriptor = { ...SRC, geojson: { idField: "id", headlineField: "h" } };
    const out = parseGeoJson(
      fc([
        line({ id: "a", h: "Vollsperrung" }, [
          [13.7, 51.0],
          [13.71, 51.0],
        ]),
        line({ id: "a", h: "Vollsperrung" }, [
          [13.8, 51.1],
          [13.81, 51.1],
        ]),
        line({ id: "b", h: "Vollsperrung" }, [
          [14.0, 51.2],
          [14.01, 51.2],
        ]),
      ]),
      src,
    );
    expect(out.map((e) => e.id)).toEqual(["test-gj:a", "test-gj:b"]);
    expect(out[0]!.geometry).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [13.7, 51.0],
          [13.71, 51.0],
        ],
        [
          [13.8, 51.1],
          [13.81, 51.1],
        ],
      ],
    });
  });
});

describe("parseGeoJson — feature ids", () => {
  const feature = (id: unknown, props: Record<string, unknown>) => ({
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [7.6, 50.3 + Number(props["nr"]) / 100] },
    properties: props,
  });

  it("reads the feature's own id with featureId, else falls back to the mapping", () => {
    const src: SourceDescriptor = { ...SRC, geojson: { featureId: true, idField: "nr" } };
    const out = parseGeoJson(
      fc([feature("baustelle.4711", { nr: "1" }), feature(undefined, { nr: "2" })]),
      src,
    );
    expect(out.map((e) => e.id)).toEqual(["test-gj:baustelle.4711", "test-gj:2"]);
  });
});

describe("parseGeoJson — direction and lanes", () => {
  const LANES: SourceDescriptor = {
    ...SRC,
    geojson: {
      idField: "id",
      typeField: "subtype",
      typeMap: { Baustelle: "roadworks", Sperrung: "road_closure" },
      directionField: "direction",
      lanesTotalField: "total",
      lanesClosedField: "closed",
    },
  };
  const at = (props: Record<string, unknown>, i: number) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [13.4 + i / 100, 52.5] },
    properties: props,
  });
  const one = (props: Record<string, unknown>) => parseGeoJson(fc([at(props, 0)]), LANES)[0]!;

  it("reads the direction as text and the lanes closed of the carriageway's", () => {
    const ev = one({ id: "a", subtype: "Baustelle", direction: "Beidseitig", total: 2, closed: 1 });
    expect(ev.direction).toBe("Beidseitig");
    expect(ev.lanesAffected).toEqual({ total: 2, closed: 1 });
  });

  it("reads no lanes where none is closed, the count is no count, or the record is a closure", () => {
    expect(
      one({ id: "b", subtype: "Baustelle", total: 2, closed: 0 }).lanesAffected,
    ).toBeUndefined();
    expect(
      one({ id: "c", subtype: "Baustelle", total: 2, closed: 3 }).lanesAffected,
    ).toBeUndefined();
    expect(
      one({ id: "d", subtype: "Baustelle", total: 2, closed: "x" }).lanesAffected,
    ).toBeUndefined();
    expect(
      one({ id: "e", subtype: "Sperrung", total: 2, closed: 2 }).lanesAffected,
    ).toBeUndefined();
  });
});

describe("parseGeoJson — record filter", () => {
  const point = (props: Record<string, unknown>) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [1, 2] },
    properties: props,
  });
  const withFilter = (filter: unknown): SourceDescriptor => ({
    ...SRC,
    geojson: { idField: "id", filter } as never,
  });

  it("keeps only features whose value is in an include list", () => {
    const out = parseGeoJson(
      fc([point({ id: "a", state: "Closed" }), point({ id: "b", state: "Open" })]),
      withFilter([{ field: "state", include: ["Closed"] }]),
    );
    expect(out.map((e) => e.id)).toEqual(["test-gj:a"]);
  });

  it("drops features whose value is in an exclude list", () => {
    const out = parseGeoJson(
      fc([point({ id: "a", state: "Easily passable" }), point({ id: "b", state: "Closed" })]),
      withFilter([{ field: "state", exclude: ["Easily passable"] }]),
    );
    expect(out.map((e) => e.id)).toEqual(["test-gj:b"]);
  });

  it("passes a missing value through exclude but fails it through include", () => {
    const excluded = parseGeoJson(
      fc([point({ id: "a" })]),
      withFilter([{ field: "state", exclude: ["Closed"] }]),
    );
    expect(excluded.map((e) => e.id)).toEqual(["test-gj:a"]);

    const included = parseGeoJson(
      fc([point({ id: "a" })]),
      withFilter([{ field: "state", include: ["Closed"] }]),
    );
    expect(included).toEqual([]);
  });

  it("requires every filter entry to pass", () => {
    const out = parseGeoJson(
      fc([
        point({ id: "a", state: "Closed", kind: "repairs" }),
        point({ id: "b", state: "Closed", kind: "weather" }),
      ]),
      withFilter([
        { field: "state", include: ["Closed"] },
        { field: "kind", exclude: ["weather"] },
      ]),
    );
    expect(out.map((e) => e.id)).toEqual(["test-gj:a"]);
  });

  it("compares values as strings, so a numeric code matches its literal", () => {
    const out = parseGeoJson(
      fc([point({ id: "a", code: 3 }), point({ id: "b", code: 1 })]),
      withFilter([{ field: "code", include: ["3"] }]),
    );
    expect(out.map((e) => e.id)).toEqual(["test-gj:a"]);
  });
});

describe("parseGeoJson — start/end coordinate LineString synthesis", () => {
  const SYNTH: SourceDescriptor = {
    ...SRC,
    geojson: {
      idField: "id",
      startLonField: "STARTX",
      startLatField: "STARTY",
      endLonField: "ENDX",
      endLatField: "ENDY",
    } as never,
  };
  const geomless = (props: Record<string, unknown>) => ({
    type: "Feature",
    geometry: null,
    properties: props,
  });

  it("builds a LineString from four WGS84 coordinate properties", () => {
    const [ev] = parseGeoJson(
      fc([geomless({ id: "a", STARTX: -19.1, STARTY: 63.4, ENDX: -19.2, ENDY: 63.5 })]),
      SYNTH,
    );
    expect(ev!.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [-19.1, 63.4],
        [-19.2, 63.5],
      ],
    });
  });

  it("drops a feature whose coordinates do not all parse", () => {
    const out = parseGeoJson(
      fc([
        geomless({ id: "a", STARTX: -19.1, STARTY: 63.4, ENDX: "n/a", ENDY: 63.5 }),
        geomless({ id: "b", STARTX: -19.1, STARTY: 63.4, ENDX: -19.2 }),
      ]),
      SYNTH,
    );
    expect(out).toEqual([]);
  });

  it("prefers real geometry over the synthesised line when the feature has both", () => {
    const [ev] = parseGeoJson(
      fc([
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-19.0, 63.0] },
          properties: { id: "a", STARTX: -19.1, STARTY: 63.4, ENDX: -19.2, ENDY: 63.5 },
        },
      ]),
      SYNTH,
    );
    expect(ev!.geometry).toEqual({ type: "Point", coordinates: [-19.0, 63.0] });
  });
});

describe("parseGeoJson — MTQ Québec warnings fixture", () => {
  const events = () => {
    const feed = testFeed("ca-qc-mtq-warnings-events");
    const gj = readFileSync(join(import.meta.dirname, "fixtures/mtq-qc/evenements.geojson"));
    return parseGeoJson(gj, feedToSourceDescriptor(feed));
  };

  it("maps each French obstruction phrase to its canonical type", () => {
    const byId = new Map(events().map((e) => [e.id, e.type]));
    expect(byId.get("ca-qc-mtq-warnings-events:124315")).toBe("road_closure");
    expect(byId.get("ca-qc-mtq-warnings-events:81387")).toBe("lane_closure");
    expect(byId.get("ca-qc-mtq-warnings-events:115026")).toBe("contraflow");
    expect(byId.get("ca-qc-mtq-warnings-events:125259")).toBe("dimension_restriction");
    // An empty `entrave` (ferry-service notices) falls back to the default.
    expect(byId.get("ca-qc-mtq-warnings-events:111875")).toBe("other");
  });

  it("reprojects the Web-Mercator geometry to Québec WGS84", () => {
    const g = events()[0]!.geometry;
    if (!g || g.type !== "LineString") throw new Error("expected LineString");
    const [lon, lat] = g.coordinates[0]!;
    expect(lon!).toBeGreaterThan(-80);
    expect(lon!).toBeLessThan(-57);
    expect(lat!).toBeGreaterThan(44);
    expect(lat!).toBeLessThan(63);
  });

  it("carries enVigueurDepuis, the road ref and the headline", () => {
    const ev = events().find((e) => e.id === "ca-qc-mtq-warnings-events:125259")!;
    expect(ev.validFrom).toMatch(/^2026-07-15T/);
    expect(ev.roads?.map((r) => r.name)).toEqual(["138"]);
    expect(ev.headline).toContain("pont Honoré-Mercier");
    expect(ev.description).toBeTruthy();
  });
});

describe("parseGeoJson — Vegagerðin Iceland line-incident fixture", () => {
  const events = () => {
    const feed = testFeed("is-vegagerdin-lines-conditions");
    const gj = readFileSync(
      join(import.meta.dirname, "fixtures/vegagerdin-is/line-incidents.json"),
    );
    return parseGeoJson(gj, feedToSourceDescriptor(feed));
  };

  it("synthesises a WGS84 LineString from the START/END columns", () => {
    const closed = events().find((e) => e.id === "is-vegagerdin-lines-conditions:913080036")!;
    expect(closed.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [-19.57021386, 63.85508479],
        [-20.02882374, 63.82486302],
      ],
    });
  });

  it("maps the English condition labels to canonical types", () => {
    const byId = new Map(events().map((e) => [e.id, e.type]));
    expect(byId.get("is-vegagerdin-lines-conditions:913080036")).toBe("road_closure"); // Closed
    expect(byId.get("is-vegagerdin-lines-conditions:911310036")).toBe("road_closure"); // Impassable
    expect(byId.get("is-vegagerdin-lines-conditions:905020036")).toBe("roadworks"); // Road repairs
    expect(byId.get("is-vegagerdin-lines-conditions:911220036")).toBe("road_condition"); // Spots of ice
    expect(byId.get("is-vegagerdin-lines-conditions:904470036")).toBe("dimension_restriction");
  });

  it("classifies the labels whose meaning is a registered situation", () => {
    const ice = events().find((e) => e.id === "is-vegagerdin-lines-conditions:911220036")!;
    expect(ice.situation?.classification).toEqual({
      kind: "road_condition",
      type: "surface",
      subtype: "icy",
    });
    const closed = events().find((e) => e.id === "is-vegagerdin-lines-conditions:913080036")!;
    expect(closed.situation?.classification).toBeUndefined();
  });

  it("filters out the passable baseline and the unknown-state segments", () => {
    const out = events();
    // The fixture holds one feature per distinct label; the two non-conditions
    // are dropped, leaving the five that say something.
    expect(out).toHaveLength(5);
    expect(out.map((e) => e.headline)).not.toContain("Easily passable");
    expect(out.map((e) => e.headline)).not.toContain("Not known");
  });

  it("carries the road number and update time", () => {
    const ev = events().find((e) => e.id === "is-vegagerdin-lines-conditions:913080036")!;
    expect(ev.roads?.map((r) => r.name)).toEqual(["F210"]);
    expect(ev.dataUpdatedAt).toBe("2026-06-02T13:34:27.000Z");
    expect(ev.description).toBe("Driving prohibited");
  });
});
