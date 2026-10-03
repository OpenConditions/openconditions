import { productionRegistry } from "@openconditions/model-registry";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { situationsToTraff, traffEventsOf } from "../situation-traff.js";

type Rec = Record<string, unknown>;

const registry = productionRegistry();
const AT = new Date("2026-09-06T10:00:00Z");
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

const effect = (id: string, kind: string, fields: Rec = {}): Rec => ({
  id,
  kind,
  v: 1,
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
  ...fields,
});

function situation(over: Rec = {}): Rec {
  return {
    id: "oc:situation:de-autobahn-events:a46",
    class: "situation",
    kind: "roadworks",
    type: "works",
    temporality: "live",
    severity: { label: "major", source: "derived" },
    validity: { status: "active", start: "2026-09-06T08:00:00Z", end: "2026-09-07T08:00:00Z" },
    effects: [effect("a46/closure", "closure", { scope: "road" })],
    location: {
      geometry: {
        type: "LineString",
        coordinates: [
          [6.805, 51.2],
          [6.818, 51.2],
        ],
      },
      roads: [{ ref: "A 46", name: [{ lang: "de", text: "Autobahn 46" }], class: "motorway" }],
    },
    provenance: { sourceUpdatedAt: "2026-09-06T09:00:00Z" },
    freshness: { fetchedAt: "2026-09-06T09:30:00Z" },
    ...over,
  };
}

const types = (s: Rec) => traffEventsOf(registry, s, AT).map((e) => e.type);

describe("traffEventsOf", () => {
  it("names the situation's nature through the crosswalk, then what each effect does to traffic", () => {
    expect(types(situation())).toEqual(["CONSTRUCTION_ROADWORKS", "RESTRICTION_CLOSED"]);
    expect(
      types(
        situation({
          effects: [
            effect("x/lanes", "lane_restriction", { vehicleImpact: "some_lanes_closed" }),
            effect("x/speed", "speed_limit", { limit: { value: 60, unit: "km/h" } }),
          ],
        }),
      ),
    ).toEqual(["CONSTRUCTION_ROADWORKS", "RESTRICTION_LANE_CLOSED", "RESTRICTION_SPEED_LIMIT"]);
  });

  it("carries a speed limit and a queue length as quantifiers, and a detour as a diversion", () => {
    const events = traffEventsOf(
      registry,
      situation({
        effects: [
          effect("x/speed", "speed_limit", { limit: { value: 59.6, unit: "km/h" } }),
          effect("x/delay", "delay", { queueLength: { value: 2400, unit: "m" } }),
          effect("x/detour", "detour"),
        ],
      }),
      AT,
    );
    expect(events).toEqual([
      { cls: "CONSTRUCTION", type: "CONSTRUCTION_ROADWORKS", diversion: true },
      { cls: "RESTRICTION", type: "RESTRICTION_SPEED_LIMIT", quantifiers: { speed: 60 } },
      { cls: "DELAY", type: "DELAY_DELAY", quantifiers: { length: 2400 } },
    ]);
  });

  it("leaves out an effect that has ended", () => {
    const ended = effect("x/closure", "closure", {
      scope: "road",
      validity: { status: "active", start: "2026-09-05T00:00:00Z", end: "2026-09-06T09:00:00Z" },
    });
    expect(types(situation({ effects: [ended] }))).toEqual(["CONSTRUCTION_ROADWORKS"]);
  });

  it("tells nothing of a situation with a vehicle-specific effect, rather than widen it to all traffic", () => {
    const trucks = effect("x/closure", "closure", {
      scope: "road",
      applicability: { kind: "classes", include: [{ class: "hgv" }] },
    });
    expect(types(situation({ effects: [trucks] }))).toEqual([]);
    const height = effect("x/height", "dimension_limit", {
      dimension: "height",
      meaning: "maximum_permitted",
      value: { value: 3.8, unit: "m" },
    });
    expect(types(situation({ effects: [height] }))).toEqual([]);
    const partial = effect("x/closure", "closure", { scope: "road", normalization: "partial" });
    expect(types(situation({ effects: [partial] }))).toEqual([]);
  });
});

describe("situationsToTraff — effects with their own place", () => {
  it("tells an effect with its own location as its own message there", () => {
    const elsewhere = effect("a46/ramp", "closure", {
      scope: "road",
      location: {
        geometry: { type: "Point", coordinates: [6.9, 51.3] },
        extent: "point",
        geometryOrigin: "source",
      },
    });
    const xml = situationsToTraff(registry, [situation({ effects: [elsewhere] })], AT);
    const messages = parser.parse(xml).feed.message as Rec[];
    expect(messages.map((m) => [m["@_id"], (m["location"] as Rec)["at"]])).toEqual([
      ["oc:situation:de-autobahn-events:a46", undefined],
      ["oc:situation:de-autobahn-events:a46#a46/ramp", "+51.3 +6.9"],
    ]);
    const types = (m: Rec) =>
      [(m["events"] as Rec)["event"] as Rec | Rec[]].flat().map((e) => e["@_type"]);
    expect(types(messages[0]!)).toEqual(["CONSTRUCTION_ROADWORKS"]);
    expect(types(messages[1]!)).toEqual(["RESTRICTION_CLOSED"]);
  });
});

describe("situationsToTraff", () => {
  it("writes one message per tellable situation with its times, urgency and location", () => {
    const xml = situationsToTraff(
      registry,
      [
        situation(),
        situation({
          id: "oc:situation:de-autobahn-events:hgv",
          effects: [effect("h", "closure", { scope: "road", applicability: { kind: "unknown" } })],
        }),
      ],
      AT,
    );
    const message = parser.parse(xml).feed.message;
    expect(message).toMatchObject({
      "@_id": "oc:situation:de-autobahn-events:a46",
      "@_receive_time": "2026-09-06T09:30:00Z",
      "@_update_time": "2026-09-06T09:00:00Z",
      "@_urgency": "URGENT",
      "@_start_time": "2026-09-06T08:00:00Z",
      "@_end_time": "2026-09-07T08:00:00Z",
      "@_expiration_time": "2026-09-07T08:00:00Z",
      events: {
        event: [
          { "@_class": "CONSTRUCTION", "@_type": "CONSTRUCTION_ROADWORKS" },
          { "@_class": "RESTRICTION", "@_type": "RESTRICTION_CLOSED" },
        ],
      },
      location: {
        "@_road_ref": "A 46",
        "@_road_name": "Autobahn 46",
        "@_road_class": "MOTORWAY",
        "@_directionality": "ONE_DIRECTION",
        from: "+51.2 +6.805",
        to: "+51.2 +6.818",
      },
    });
  });
});
