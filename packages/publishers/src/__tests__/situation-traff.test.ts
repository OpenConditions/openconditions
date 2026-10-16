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

  it.each([false, true])(
    "withholds conflicting speed limits independently of order (%s)",
    (reverse) => {
      const effects = [60, 80].map((value) =>
        effect(`speed-${value}`, "speed_limit", { limit: { value, unit: "km/h" } }),
      );
      if (reverse) effects.reverse();
      const diagnostics: { code: string; effectId?: string }[] = [];
      const s = situation({ effects });
      expect(traffEventsOf(registry, s, AT, (d) => diagnostics.push(d))).toEqual([]);
      expect(traffEventsOf(registry, s, AT)).toEqual([]);
      expect(diagnostics.filter((d) => d.code === "conflicting_effects")).toHaveLength(2);
    },
  );

  it("deduplicates equivalent restrictions but refuses different lane scope or compliance", () => {
    const speed = effect("a", "speed_limit", { limit: { value: 60, unit: "km/h" } });
    expect(
      types(
        situation({
          effects: [
            speed,
            {
              ...speed,
              id: "b",
              sourceRecordRef: "upstream-b",
              source: { path: "/other" },
              validity: situation()["validity"],
              limit: { unit: "km/h", value: 60 },
            },
          ],
        }),
      ),
    ).toEqual(["CONSTRUCTION_ROADWORKS", "RESTRICTION_SPEED_LIMIT"]);
    for (const fields of [{ compliance: "advisory" }, { laneScope: [{ index: 1 }] }]) {
      expect(types(situation({ effects: [speed, { ...speed, id: "b", ...fields }] }))).toEqual([]);
    }
  });

  it("reports phase conflicts at their canonical paths and ignores ended duplicates", () => {
    const speed = effect("a", "speed_limit", { limit: { value: 60, unit: "km/h" } });
    const other = effect("phase-speed", "speed_limit", { limit: { value: 80, unit: "km/h" } });
    const diagnostics: { code: string; path: string; scope: string; disposition: string }[] = [];
    const s = situation({ effects: [speed], details: { phases: [{ effects: [other] }] } });
    expect(traffEventsOf(registry, s, AT, (d) => diagnostics.push(d))).toEqual([]);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "conflicting_effects",
        path: "/details/phases/0/effects/0",
        scope: "message",
        disposition: "withheld",
      }),
    );
    const ended = { ...other, validity: { status: "ended", end: "2026-09-06T09:00:00Z" } };
    expect(types(situation({ effects: [speed, ended] }))).toContain("RESTRICTION_SPEED_LIMIT");
  });

  it("retains independently located effects when the main message conflicts", () => {
    const s = situation({
      effects: [
        effect("a", "speed_limit", { limit: { value: 60, unit: "km/h" } }),
        effect("b", "speed_limit", { limit: { value: 80, unit: "km/h" } }),
        effect("elsewhere", "speed_limit", {
          limit: { value: 40, unit: "km/h" },
          location: { geometry: { type: "Point", coordinates: [7, 52] } },
        }),
      ],
    });
    const xml = situationsToTraff(registry, [s], AT);
    expect(xml).toContain("#elsewhere");
    expect(xml).toContain('speed="40"');
    expect(xml).not.toContain('speed="60"');
    expect(xml).not.toContain('speed="80"');
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

  it.each([
    [0, "0:00"],
    [60, "0:01"],
    [5400, "1:30"],
    [86340, "23:59"],
    [86400, "24:00"],
    [89, "0:01"],
    [90, "0:02"],
  ])("exports %s delay seconds as q_duration=%s", (seconds, duration) => {
    const s = situation({
      effects: [effect("x/delay", "delay", { delay: { value: seconds, unit: "s" } })],
    });
    expect(traffEventsOf(registry, s, AT)).toContainEqual({
      cls: "DELAY",
      type: "DELAY_DELAY",
      quantifiers: { q_duration: duration },
    });
    const xml = situationsToTraff(registry, [s], AT);
    expect(xml).toContain(`q_duration="${duration}"`);
  });

  it("preserves queue length and distinct delay durations without summing them", () => {
    const s = situation({
      effects: [
        effect("a", "delay", {
          delay: { value: 600, unit: "s" },
          queueLength: { value: 2400, unit: "m" },
        }),
        effect("b", "delay", { delay: { value: 1200, unit: "s" } }),
        effect("duplicate", "delay", { delay: { value: 1200, unit: "s" } }),
      ],
    });
    expect(traffEventsOf(registry, s, AT).filter((e) => e.type === "DELAY_DELAY")).toEqual([
      { cls: "DELAY", type: "DELAY_DELAY", quantifiers: { length: 2400, q_duration: "0:10" } },
      { cls: "DELAY", type: "DELAY_DELAY", quantifiers: { q_duration: "0:20" } },
    ]);
  });

  it.each([0.1, 29, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])(
    "withholds unrepresentable duration %s and explains the loss",
    (seconds) => {
      const diagnostics: { code: string; path: string; disposition: string }[] = [];
      const xml = situationsToTraff(
        registry,
        [
          situation({
            effects: [
              effect("delay", "delay", {
                delay: { value: seconds, unit: "s" },
                queueLength: { value: 400, unit: "m" },
              }),
            ],
          }),
        ],
        AT,
        (d) => diagnostics.push(d),
      );
      expect(xml).not.toContain("q_duration=");
      expect(xml).toContain('length="400"');
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: "field_not_exported",
          path: "/effects/0/delay",
          disposition: "omitted",
        }),
      );
    },
  );

  it("reports whole-minute precision loss, but no loss for an exact duration", () => {
    for (const [seconds, reduced] of [
      [90, true],
      [120, false],
    ] as const) {
      const diagnostics: { code: string; path: string; disposition: string }[] = [];
      situationsToTraff(
        registry,
        [
          situation({
            effects: [effect("delay", "delay", { delay: { value: seconds, unit: "s" } })],
          }),
        ],
        AT,
        (d) => diagnostics.push(d),
      );
      expect(diagnostics.some((d) => d.code === "field_not_exported")).toBe(false);
      expect(
        diagnostics.some(
          (d) =>
            d.code === "field_precision_reduced" &&
            d.path === "/effects/0/delay" &&
            d.disposition === "reduced",
        ),
      ).toBe(reduced);
    }
  });

  it("keeps durations on their effect's own message and observes effect validity", () => {
    const xml = situationsToTraff(
      registry,
      [
        situation({
          effects: [
            effect("ended", "delay", {
              delay: { value: 600, unit: "s" },
              validity: { status: "active", end: "2026-09-06T09:00:00Z" },
            }),
            effect("ramp", "delay", {
              delay: { value: 1200, unit: "s" },
              location: { geometry: { type: "Point", coordinates: [6.9, 51.3] } },
            }),
          ],
        }),
      ],
      AT,
    );
    const messages = parser.parse(xml).feed.message as Rec[];
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[0])).not.toContain("q_duration");
    expect(JSON.stringify(messages[1])).toContain('"@_q_duration":"0:20"');
    expect(xml).not.toContain('q_duration="0:10"');
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
        "@_directionality": "BOTH_DIRECTIONS",
        from: "+51.2 +6.805",
        to: "+51.2 +6.818",
      },
    });
  });
});

describe("TraFF direction and reader compatibility", () => {
  it.each(["LineString", "Point"])(
    "keeps a bidirectional %s bidirectional without compass prose",
    (type) => {
      const xml = situationsToTraff(
        registry,
        [
          situation({
            location: {
              geometry: {
                type,
                coordinates:
                  type === "Point"
                    ? [6.8, 51.2]
                    : [
                        [6.8, 51.2],
                        [6.9, 51.2],
                      ],
              },
              direction: { value: "both", basis: "text", text: "BOTH", compass: "E" },
            },
          }),
        ],
        AT,
      );
      expect(parser.parse(xml).feed.message.location).toMatchObject({
        "@_directionality": "BOTH_DIRECTIONS",
      });
      expect(parser.parse(xml).feed.message.location["@_direction"]).toBeUndefined();
    },
  );

  it.each([
    { value: "unknown", basis: "text", text: "towards the city centre" },
    { value: "unknown", basis: "compass", compass: "W" },
    { value: "unknown", basis: "bearing", bearingDeg: 270 },
    { value: "positive", basis: "road_reference" },
    { value: "negative", basis: "alert_c" },
    { value: "negative", basis: "openlr" },
  ])("does not invent travel order for $basis/$value", (direction) => {
    const record = situation();
    record["location"] = { ...(record["location"] as Rec), direction };
    expect(parser.parse(situationsToTraff(registry, [record], AT)).feed.message).toBeUndefined();
  });

  it("does not widen an effect's explicit unknown direction", () => {
    const record = situation({
      effects: [
        effect("x/closure", "closure", {
          scope: "road",
          direction: { value: "unknown", basis: "text", text: "west carriageway" },
        }),
      ],
    });
    expect(parser.parse(situationsToTraff(registry, [record], AT)).feed.message).toBeUndefined();
  });

  it("serializes fractional and offset timestamps for second-resolution TraFF readers", () => {
    const record = situation({
      provenance: { sourceUpdatedAt: "2026-09-06T11:00:00.123+02:00" },
      freshness: { fetchedAt: "2026-09-06T09:30:00.000Z", expiresAt: "2026-09-07T08:00:00.987Z" },
      validity: {
        status: "active",
        start: "2026-09-06T10:00:00.456+02:00",
        end: "2026-09-07T08:00:00.789Z",
      },
    });
    expect(parser.parse(situationsToTraff(registry, [record], AT)).feed.message).toMatchObject({
      "@_receive_time": "2026-09-06T09:30:00Z",
      "@_update_time": "2026-09-06T09:00:00Z",
      "@_expiration_time": "2026-09-07T08:00:00Z",
      "@_start_time": "2026-09-06T08:00:00Z",
      "@_end_time": "2026-09-07T08:00:00Z",
    });
  });
});

it("does not widen a direction declared only in an effect's partial location", () => {
  const record = situation({
    effects: [
      effect("x/closure", "closure", {
        scope: "road",
        location: { direction: { value: "negative", basis: "alert_c" } },
      }),
    ],
  });
  expect(parser.parse(situationsToTraff(registry, [record], AT)).feed.message).toBeUndefined();
});
