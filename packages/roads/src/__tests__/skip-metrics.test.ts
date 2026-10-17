import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, it } from "vitest";
import { parseAutobahn } from "../autobahn.js";
import { parseCars } from "../cars.js";
import { parseDigitraffic } from "../digitraffic.js";
import { parseFlatJson } from "../flatjson.js";
import { parseGddkia } from "../gddkia.js";
import { parseGeoJson } from "../geojson.js";
import { parseIbi511, parseIbi511Conditions } from "../ibi511.js";
import { parseLtaIncidents } from "../lta.js";
import { parseOhgoEvents } from "../ohgo-events.js";
import { parseOpen511 } from "../open511.js";
import { parseEvents } from "../parse.js";
import { parseTrafikverket } from "../trafikverket.js";
import type { SourceDescriptor } from "../types.js";
import { parseVicDisruptions } from "../vic-disruptions.js";
import { parseWzdx } from "../wzdx.js";
import { roadFeed } from "./helpers/road-feed.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const src = (id: string): SourceDescriptor => ({
  id,
  attribution: "t",
  country: "XX",
  license: "CC0-1.0",
});

/**
 * Every parser that drops a record for want of coordinates must report it per
 * source. An absent count has to mean "this feed loses nothing", not "nobody
 * measured this feed" — the whole point of the metric is that a silently
 * shrinking feed looks identical to a healthy one.
 */
describe("no-geometry skips are reported by every parser that drops records", () => {
  beforeEach(() => __resetSkips());

  it("autobahn", () => {
    parseAutobahn(readFileSync(join(FIXTURES, "autobahn/warning.json")), src("de-autobahn-events"));
    expect(drainSkipped("de-autobahn-events").no_geometry ?? 0).toBeGreaterThan(0);
  });

  it("digitraffic", () => {
    parseDigitraffic(readFileSync(join(FIXTURES, "digitraffic/messages.json")), src("fi-dt"));
    expect(drainSkipped("fi-dt").no_geometry ?? 0).toBeGreaterThan(0);
  });

  it("wzdx", () => {
    const feed = {
      type: "FeatureCollection",
      features: [
        {
          id: "no-geo",
          type: "Feature",
          properties: { core_details: { event_type: "work-zone" } },
          geometry: null,
        },
      ],
    };
    parseWzdx(JSON.stringify(feed), src("us-wzdx-events"));
    expect(drainSkipped("us-wzdx-events").no_geometry ?? 0).toBe(1);
  });

  it("open511", () => {
    const feed = { events: [{ id: "no-geo", status: "ACTIVE", headline: "x" }] };
    parseOpen511(JSON.stringify(feed), src("ca-bc-drivebc-events"));
    expect(drainSkipped("ca-bc-drivebc-events").no_geometry ?? 0).toBe(1);
  });

  it("keeps every source's count separate", () => {
    parseWzdx(
      JSON.stringify({
        type: "FeatureCollection",
        features: [{ id: "a", type: "Feature", properties: {}, geometry: null }],
      }),
      src("feed-a"),
    );
    expect(drainSkipped("feed-b").no_geometry ?? 0).toBe(0);
    expect(drainSkipped("feed-a").no_geometry ?? 0).toBe(1);
  });
});

const point = { type: "Point", coordinates: [8.68, 50.11] };
const json = (value: unknown) => JSON.stringify(value);

/**
 * Beyond missing coordinates, each event parser reports the records it drops
 * as malformed and the enumerated values it publishes a record without.
 */
describe("event parsers report malformed records and unknown values", () => {
  beforeEach(() => __resetSkips());

  it("open511: an event without an id is dropped, never given a made-up one", () => {
    const events = parseOpen511(
      json({
        events: [
          { geography: point, status: "ACTIVE" },
          {
            id: "e1",
            geography: point,
            status: "PAUSED",
            event_type: "METEOR",
            severity: "SEVERE",
            roads: [{ name: "x", state: "FLYING" }],
          },
        ],
      }),
      src("o"),
    );
    expect(events.map((e) => e.id)).toEqual(["o:e1"]);
    expect(drainSkipped("o")).toEqual({ malformed: 1, unknown_value: 4 });
  });

  it("geojson: a type or severity the mapping does not hold, and a feature that is no object", () => {
    const mapping = {
      idField: "id",
      typeField: "kind",
      typeMap: { crash: "accident" as const },
      severityField: "sev",
      severityMap: { hi: "high" as const },
    };
    const events = parseGeoJson(
      json({
        type: "FeatureCollection",
        features: [
          null,
          { type: "Feature", properties: { id: "a", kind: "crash", sev: "hi" }, geometry: point },
          { type: "Feature", properties: { id: "b", kind: "meteor", sev: "mid" }, geometry: point },
        ],
      }),
      { ...src("g"), geojson: mapping },
    );
    expect(events).toHaveLength(2);
    expect(drainSkipped("g")).toEqual({ malformed: 1, unknown_value: 2 });
  });

  it("geojson: a type with no typeMap to read it takes the feed's default, not unknown", () => {
    parseGeoJson(
      json({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { id: "a", kind: "meteor" }, geometry: point }],
      }),
      { ...src("g"), geojson: { idField: "id", typeField: "kind", defaultType: "hazard" } },
    );
    expect(drainSkipped("g")).toEqual({});
  });

  it("flatjson: a row that is no object", () => {
    const events = parseFlatJson(json([null, 3, { id: "a", lon: 100.5, lat: 13.7 }]), {
      ...src("f"),
      geojson: { idField: "id", lonField: "lon", latField: "lat" },
    });
    expect(events).toHaveLength(1);
    expect(drainSkipped("f")).toEqual({ malformed: 2 });
  });

  it("cars: an event without an id, and phrases the crosswalk does not know", () => {
    const events = parseCars(
      json([
        { headline: { code: "crash" }, geometry: point },
        { "event-id": "a", headline: { code: "meteor strike" }, geometry: point },
        { "event-id": "b", headline: { code: "crash" }, geometry: point },
      ]),
      src("c"),
    );
    expect(events.map((e) => e.id).sort()).toEqual(["c:a", "c:b"]);
    expect(drainSkipped("c")).toEqual({ malformed: 1, unknown_value: 1 });
  });

  it("cars: a complete snapshot refuses an event without an id rather than counting it", () => {
    const feed = roadFeed({
      id: "c-snap",
      region: "us",
      format: "cars",
      attribution: "t",
      license: "CC0-1.0",
      snapshot: { completeness: "complete" },
    });
    const ok = json([
      { "event-id": "a", headline: { code: "meteor strike" }, geometry: point },
      { "event-id": "b", headline: { code: "crash" } },
    ]);
    const out = parseEvents(feed, [Buffer.from(ok)]);
    expect(out.records).toMatchObject({ accepted: 1, unlocatable: 1 });
    expect(drainSkipped("c-snap")).toEqual({ no_geometry: 1, unknown_value: 1 });
    const unnamed = json([{ headline: { code: "crash" }, geometry: point }]);
    expect(() => parseEvents(feed, [Buffer.from(unnamed)])).toThrow(/missing_identity/);
  });

  it("digitraffic: a feature without an identity, and an unknown situation type", () => {
    const feature = (properties: Record<string, unknown>) => ({
      type: "Feature",
      geometry: point,
      properties: { announcements: [], ...properties },
    });
    const events = parseDigitraffic(
      json({
        type: "FeatureCollection",
        features: [
          feature({ situationType: "TRAFFIC_ANNOUNCEMENT" }),
          feature({ situationId: "a", situationType: "METEOR" }),
          feature({ situationId: "b", situationType: "ROAD_WORK" }),
        ],
      }),
      src("d"),
    );
    expect(events).toHaveLength(2);
    expect(drainSkipped("d")).toEqual({ malformed: 1, unknown_value: 1 });
  });

  it("ibi511: an unparseable position, an unknown event type and severity", () => {
    const events = parseIbi511(
      json([
        { ID: 1, Latitude: "x", Longitude: -79.4 },
        { ID: 2, EventType: "meteor", Severity: "Apocalyptic", Latitude: 43.6, Longitude: -79.4 },
        { ID: 3, EventType: "roadwork", Severity: "None", Latitude: 43.6, Longitude: -79.4 },
        null,
      ]),
      src("i"),
    );
    expect(events).toHaveLength(2);
    expect(drainSkipped("i")).toEqual({ malformed: 2, unknown_value: 2 });
  });

  it("ibi511 conditions: a record that is no object", () => {
    parseIbi511Conditions(json([null, "x"]), src("ic"));
    expect(drainSkipped("ic")).toEqual({ malformed: 2 });
  });

  it("lta: an unknown type and a position that is no number", () => {
    const events = parseLtaIncidents(
      json({
        value: [
          { Type: "Meteor", Latitude: 1.3, Longitude: 103.8 },
          { Type: "Accident", Latitude: "1.3", Longitude: 103.8 },
          null,
        ],
      }),
      src("l"),
    );
    expect(events).toHaveLength(1);
    expect(drainSkipped("l")).toEqual({ malformed: 2, unknown_value: 1 });
  });

  it("gddkia: a position that does not parse and an unknown typ", () => {
    const utr = (typ: string, lat: string) =>
      `<utr><typ>${typ}</typ><geo_lat>${lat}</geo_lat><geo_long>21</geo_long></utr>`;
    const events = parseGddkia(
      `<utrudnienia>${utr("X", "52.2")}${utr("U", "n/a")}</utrudnienia>`,
      src("p"),
    );
    expect(events).toHaveLength(1);
    expect(drainSkipped("p")).toEqual({ malformed: 1, unknown_value: 1 });
  });

  it("ohgo: a record without an id is malformed, a null position has no geometry", () => {
    const events = parseOhgoEvents(
      json({
        Results: [
          { latitude: 40, longitude: -83 },
          { id: "a", latitude: null, longitude: null },
          { id: "b", latitude: 40, longitude: -83, category: "Meteor", roadStatus: "Flying" },
        ],
      }),
      src("h"),
    );
    expect(events.map((e) => e.id)).toEqual(["h:b"]);
    expect(drainSkipped("h")).toEqual({ malformed: 1, no_geometry: 1, unknown_value: 2 });
  });

  it("trafikverket: no id, WKT that does not parse, unknown message type and severity", () => {
    const deviation = (d: Record<string, unknown>) => ({
      Message: "x",
      Geometry: { WGS84: "POINT (18 59)" },
      ...d,
    });
    const events = parseTrafikverket(
      json({
        RESPONSE: {
          RESULT: [
            {
              Situation: [
                {
                  Deviation: [
                    deviation({}),
                    deviation({ Id: "a", Geometry: { WGS84: "POINT (x y)" } }),
                    deviation({ Id: "b", MessageType: "Meteor", SeverityCode: 9 }),
                    null,
                  ],
                },
              ],
            },
          ],
        },
      }),
      src("t"),
    );
    expect(events).toHaveLength(1);
    expect(drainSkipped("t")).toEqual({ malformed: 3, unknown_value: 2 });
  });

  it("autobahn: a coordinate that does not parse and an unknown display type", () => {
    const events = parseAutobahn(
      json({
        warning: [
          { identifier: "a", coordinate: { lat: "x", long: "8.6" } },
          { identifier: "b", display_type: "METEOR", coordinate: { lat: "50.1", long: "8.6" } },
          { identifier: "c", display_type: "WARNING", coordinate: { lat: "50.2", long: "8.6" } },
        ],
      }),
      src("a"),
    );
    expect(events).toHaveLength(2);
    expect(drainSkipped("a")).toEqual({ malformed: 1, unknown_value: 1 });
  });

  it("vic-disruptions: a record without an id, and an unknown event type", () => {
    const events = parseVicDisruptions(
      json({
        disruptions: [
          { name: "x", geometry: point },
          { id: "a", eventType: "Meteor", geometry: point },
          { id: "b", eventType: "Incident", geometry: point },
          7,
        ],
      }),
      src("v"),
    );
    expect(events).toHaveLength(2);
    expect(drainSkipped("v")).toEqual({ malformed: 2, unknown_value: 1 });
  });
});
