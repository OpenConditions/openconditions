import { describe, expect, it } from "vitest";
import type { ExportDiagnostic } from "../export-diagnostics.js";
import { cifsIncidentsOf, situationsToCifsJson, situationsToCifsXml } from "../situation-cifs.js";

type Rec = Record<string, unknown>;

const AT = new Date("2026-09-06T10:00:00Z");

const LINE = {
  type: "LineString",
  coordinates: [
    [9.18, 48.78],
    [9.19, 48.79],
  ],
};

const ROAD = { name: [{ lang: "de", text: "B10" }] };

const effect = (id: string, kind: string, fields: Rec = {}): Rec => ({
  id,
  kind,
  v: 1,
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
  ...fields,
});

function situation(id: string, over: Rec = {}): Rec {
  return {
    id: `oc:situation:test:${id}`,
    class: "situation",
    kind: "roadworks",
    type: "works",
    temporality: "live",
    certainty: "observed",
    severity: { label: "moderate", source: "derived" },
    description: [{ lang: "en", text: "Roadworks on B10" }],
    validity: { status: "active", start: "2026-09-06T08:00:00Z", end: "2026-09-07T08:00:00Z" },
    effects: [],
    location: {
      geometry: LINE,
      roads: [ROAD],
      direction: { value: "positive", basis: "geometry" },
    },
    provenance: { sourceUpdatedAt: "2026-09-06T09:00:00Z" },
    freshness: { fetchedAt: "2026-09-06T09:30:00Z" },
    ...over,
  };
}

describe("CIFS outbound emitter", () => {
  it("emits ROAD_CLOSED only for complete road-scoped closures with explicit validity.start", () => {
    const valid = situation("closure-ok", {
      kind: "roadworks",
      type: "works",
      subtype: "construction",
      effects: [effect("c1", "closure", { scope: "road" })],
    });
    const [inc] = cifsIncidentsOf(valid, AT);
    expect(inc).toMatchObject({
      id: "oc:situation:test:closure-ok",
      type: "ROAD_CLOSED",
      subtype: "ROAD_CLOSED_CONSTRUCTION",
      direction: "ONE_DIRECTION",
      starttime: "2026-09-06T08:00:00Z",
      endtime: "2026-09-07T08:00:00Z",
    });

    // Missing validity.start withholds ROAD_CLOSED (never falls back to sourceUpdatedAt/fetchedAt)
    const noStartDiags: ExportDiagnostic[] = [];
    expect(
      cifsIncidentsOf(
        situation("closure-nostart", {
          effects: [effect("c1", "closure", { scope: "road" })],
          validity: { status: "active", end: "2026-09-07T08:00:00Z" },
        }),
        AT,
        (d) => noStartDiags.push(d),
      ),
    ).toEqual([]);
    expect(noStartDiags).toContainEqual(
      expect.objectContaining({ code: "unsupported_timing", path: "/validity/start" }),
    );

    // Sidewalk closure is not a ROAD_CLOSED
    const sidewalkDiags: ExportDiagnostic[] = [];
    const sidewalk = situation("sidewalk", {
      kind: "closure",
      type: "closure",
      effects: [effect("c1", "closure", { scope: "sidewalk" })],
    });
    expect(cifsIncidentsOf(sidewalk, AT, (d) => sidewalkDiags.push(d))).toEqual([]);
    expect(sidewalkDiags).toContainEqual(
      expect.objectContaining({ code: "unsupported_effect", path: "/effects/0/scope" }),
    );

    // all_lanes_closed lane_restriction does NOT synthesize ROAD_CLOSED
    const allLanes = situation("all-lanes", {
      kind: "closure",
      type: "closure",
      effects: [effect("l1", "lane_restriction", { vehicleImpact: "all_lanes_closed" })],
    });
    const [laneInc] = cifsIncidentsOf(allLanes, AT);
    expect(laneInc?.type).toBe("HAZARD");
    expect(laneInc?.subtype).toBe("HAZARD_ON_ROAD_LANE_CLOSED");
  });

  it("handles geometry directionality: reverses negative geometry lines and enforces bilateral-only single points", () => {
    const reversed = situation("neg-line", {
      location: {
        geometry: LINE,
        roads: [ROAD],
        direction: { value: "negative", basis: "geometry" },
      },
    });
    const [revInc] = cifsIncidentsOf(reversed, AT);
    expect(revInc?.direction).toBe("ONE_DIRECTION");
    expect(revInc?.polyline).toBe("48.790000 9.190000 48.780000 9.180000");

    // Compass direction withheld
    const compassDiags: ExportDiagnostic[] = [];
    expect(
      cifsIncidentsOf(
        situation("compass", {
          location: {
            geometry: LINE,
            roads: [ROAD],
            direction: { value: "unknown", basis: "compass", compass: "N" },
          },
        }),
        AT,
        (d) => compassDiags.push(d),
      ),
    ).toEqual([]);
    expect(compassDiags).toContainEqual(
      expect.objectContaining({ code: "unrepresentable_direction" }),
    );

    // Single-point alert with explicit bilateral direction succeeds
    const bilateralPoint = situation("pt-both", {
      kind: "incident",
      type: "accident",
      severity: { label: "major", source: "derived" },
      location: {
        geometry: { type: "Point", coordinates: [9.18, 48.78] },
        roads: [ROAD],
        direction: { value: "both", basis: "text", text: "BOTH_DIRECTIONS" },
      },
    });
    const [ptInc] = cifsIncidentsOf(bilateralPoint, AT);
    expect(ptInc).toMatchObject({
      type: "ACCIDENT",
      subtype: "ACCIDENT_MAJOR",
      polyline: "48.780000 9.180000",
      direction: "BOTH_DIRECTIONS",
    });

    // Single-point alert with absent or non-both direction is withheld
    expect(
      cifsIncidentsOf(
        situation("pt-nodir", {
          kind: "incident",
          type: "accident",
          location: { geometry: { type: "Point", coordinates: [9.18, 48.78] }, roads: [ROAD] },
        }),
        AT,
      ),
    ).toEqual([]);

    // Single-point closure is ALWAYS withheld even with bilateral direction
    expect(
      cifsIncidentsOf(
        situation("pt-closure", {
          effects: [effect("c1", "closure", { scope: "road" })],
          location: {
            geometry: { type: "Point", coordinates: [9.18, 48.78] },
            roads: [ROAD],
            direction: { value: "both", basis: "text", text: "BOTH_DIRECTIONS" },
          },
        }),
        AT,
      ),
    ).toEqual([]);
  });

  it("rejects circular, zero-length/rounded-collapsed, and >20 km closure polylines", () => {
    // Circular polyline (first === last with >= 3 points)
    expect(
      cifsIncidentsOf(
        situation("circular", {
          location: {
            geometry: {
              type: "LineString",
              coordinates: [
                [9.18, 48.78],
                [9.19, 48.79],
                [9.18, 48.78],
              ],
            },
            roads: [ROAD],
          },
        }),
        AT,
      ),
    ).toEqual([]);

    // Two vertices that collapse after 6-decimal rounding
    expect(
      cifsIncidentsOf(
        situation("collapsed", {
          location: {
            geometry: {
              type: "LineString",
              coordinates: [
                [9.1800001, 48.7800001],
                [9.1800002, 48.7800002],
              ],
            },
            roads: [ROAD],
          },
        }),
        AT,
      ),
    ).toEqual([]);

    // >20 km closure withheld, while non-closure alert is allowed
    const longLine = {
      type: "LineString",
      coordinates: [
        [9.0, 48.0],
        [9.0, 48.3], // ~33 km
      ],
    };
    expect(
      cifsIncidentsOf(
        situation("long-closure", {
          effects: [effect("c1", "closure", { scope: "road" })],
          location: { geometry: longLine, roads: [ROAD] },
        }),
        AT,
      ),
    ).toEqual([]);
    expect(
      cifsIncidentsOf(
        situation("long-alert", {
          location: { geometry: longLine, roads: [ROAD] },
        }),
        AT,
      ),
    ).toHaveLength(1);
  });

  it("exports schedules honoring authoritative duration and rejecting unsupported rules/timezones/suspended status", () => {
    // Valid weekday schedule in matching geometry timezone (Europe/Berlin)
    const scheduled = situation("sched-ok", {
      validity: {
        status: "active",
        start: "2026-09-01T00:00:00+02:00",
        end: "2026-09-30T23:59:00+02:00",
        periods: [
          {
            repeatFrequency: "P1W",
            byDay: ["MO", "WE"],
            startTime: "08:00",
            duration: "PT4H",
            scheduleTimezone: "Europe/Berlin",
          },
        ],
      },
    });
    const [inc] = cifsIncidentsOf(scheduled, AT);
    expect(inc?.schedule).toEqual({ monday: "08:00-12:00", wednesday: "08:00-12:00" });

    // Suspended status withheld
    const suspDiags: ExportDiagnostic[] = [];
    expect(
      cifsIncidentsOf(
        situation("suspended", {
          validity: { status: "suspended", start: "2026-09-06T08:00:00Z" },
        }),
        AT,
        (d) => suspDiags.push(d),
      ),
    ).toEqual([]);
    expect(suspDiags).toContainEqual(
      expect.objectContaining({ code: "unsupported_timing", path: "/validity/status" }),
    );

    // Wrong timezone rejected
    expect(
      cifsIncidentsOf(
        situation("wrong-tz", {
          validity: {
            status: "active",
            start: "2026-09-01T00:00:00Z",
            periods: [
              {
                repeatFrequency: "P1D",
                startTime: "08:00",
                duration: "PT2H",
                scheduleTimezone: "America/New_York",
              },
            ],
          },
        }),
        AT,
      ),
    ).toEqual([]);

    // Duration vs endTime disagreement rejected
    expect(
      cifsIncidentsOf(
        situation("dur-mismatch", {
          validity: {
            status: "active",
            start: "2026-09-01T00:00:00+02:00",
            periods: [
              {
                repeatFrequency: "P1D",
                startTime: "08:00",
                endTime: "11:00",
                duration: "PT2H",
                scheduleTimezone: "Europe/Berlin",
              },
            ],
          },
        }),
        AT,
      ),
    ).toEqual([]);

    // Overnight schedule rejected
    expect(
      cifsIncidentsOf(
        situation("overnight", {
          validity: {
            status: "active",
            start: "2026-09-01T00:00:00+02:00",
            periods: [
              {
                repeatFrequency: "P1D",
                startTime: "22:00",
                duration: "PT7H",
                scheduleTimezone: "Europe/Berlin",
              },
            ],
          },
        }),
        AT,
      ),
    ).toEqual([]);
  });

  it("exports complete contiguous lanes on ONE_DIRECTION non-closures and splits/withholds conflicting effects", () => {
    const withLanes = situation("lanes-ok", {
      effects: [
        effect("l1", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          lanesTotal: 2,
          lanesClosed: 1,
          lanes: [
            { index: 1, status: "closed" },
            { index: 2, status: "open" },
          ],
        }),
      ],
    });
    const [inc] = cifsIncidentsOf(withLanes, AT);
    expect(inc?.lanes).toEqual([
      { order: 1, type: "LANE", status: "CLOSED" },
      { order: 2, type: "LANE", status: "OPEN" },
    ]);

    // Conflicting lane restrictions in overlapping windows are withheld
    const conflictDiags: ExportDiagnostic[] = [];
    const conflicting = situation("lanes-conflict", {
      effects: [
        effect("l1", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          lanes: [
            { index: 1, status: "closed" },
            { index: 2, status: "open" },
          ],
          validity: {
            status: "active",
            start: "2026-09-06T08:00:00Z",
            end: "2026-09-06T12:00:00Z",
          },
        }),
        effect("l2", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          lanes: [
            { index: 1, status: "open" },
            { index: 2, status: "closed" },
          ],
          validity: {
            status: "active",
            start: "2026-09-06T09:00:00Z",
            end: "2026-09-06T13:00:00Z",
          },
        }),
      ],
    });
    const conflictOut = cifsIncidentsOf(conflicting, AT, (d) => conflictDiags.push(d));
    // Split lane effects overlap and conflict, so neither split lane message is emitted
    expect(conflictOut.filter((i) => i.lanes !== undefined)).toEqual([]);
    expect(conflictDiags).toContainEqual(expect.objectContaining({ code: "conflicting_effects" }));

    // XML and JSON share identical incident projection
    const json = situationsToCifsJson([withLanes], AT, { timestamp: "2026-09-06T10:00:00Z" });
    const xml = situationsToCifsXml([withLanes], AT, { timestamp: "2026-09-06T10:00:00Z" });
    expect(json.incidents).toHaveLength(1);
    expect(xml).toContain('timestamp="2026-09-06T10:00:00Z"');
    expect(xml).toContain("<type>HAZARD</type>");
    expect(xml).toContain("<order>1</order>");
  });

  it("refuses ROAD_CLOSED for rejected future actions, lane-scoped closures, and advisory closures", () => {
    const rejectedFuture = situation("rejected-future", {
      kind: "closure",
      type: "closure",
      validity: { status: "active", start: "2026-09-07T08:00:00Z", end: "2026-09-08T08:00:00Z" },
      effects: [effect("c1", "closure", { scope: "road", actionStatus: "rejected" })],
    });
    expect(cifsIncidentsOf(rejectedFuture, AT)).toEqual([]);

    const laneScoped = situation("lane-scoped-closure", {
      kind: "closure",
      type: "closure",
      effects: [
        effect("c1", "closure", {
          scope: "road",
          laneScope: [{ index: 1 }],
        }),
      ],
    });
    expect(cifsIncidentsOf(laneScoped, AT)).toEqual([]);

    const advisory = situation("advisory-closure", {
      kind: "closure",
      type: "closure",
      effects: [effect("c1", "closure", { scope: "road", compliance: "advisory" })],
    });
    expect(cifsIncidentsOf(advisory, AT)).toEqual([]);
  });

  it("reconciles outbound lane counts, checks all_lanes_open conflicts, and allows non-overlapping day schedules", () => {
    // Partial lane list (2 items) on an effect declaring 4 lanesTotal / 2 lanesClosed omits <lanes>
    const partialLanesDiags: ExportDiagnostic[] = [];
    const partialLanes = situation("partial-lanes", {
      effects: [
        effect("l1", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          lanesTotal: 4,
          lanesClosed: 2,
          lanes: [
            { index: 1, status: "closed" },
            { index: 2, status: "open" },
          ],
        }),
      ],
    });
    const [partialInc] = cifsIncidentsOf(partialLanes, AT, (d) => partialLanesDiags.push(d));
    expect(partialInc?.lanes).toBeUndefined();
    expect(partialLanesDiags).toContainEqual(
      expect.objectContaining({ code: "field_not_exported" }),
    );

    // Overlapping all_lanes_open conflicts with closed-lane bucket at same place & direction
    const openVsClosedDiags: ExportDiagnostic[] = [];
    const openVsClosed = situation("open-vs-closed", {
      kind: "closure",
      type: "closure",
      subtype: "lane",
      effects: [
        effect("l1", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          lanes: [
            { index: 1, status: "closed" },
            { index: 2, status: "open" },
          ],
          validity: {
            status: "active",
            start: "2026-09-06T08:00:00Z",
            end: "2026-09-06T12:00:00Z",
          },
        }),
        effect("l2", "lane_restriction", {
          vehicleImpact: "all_lanes_open",
          validity: {
            status: "active",
            start: "2026-09-06T09:00:00Z",
            end: "2026-09-06T13:00:00Z",
          },
        }),
      ],
    });
    expect(cifsIncidentsOf(openVsClosed, AT, (d) => openVsClosedDiags.push(d))).toEqual([]);
    expect(openVsClosedDiags).toContainEqual(
      expect.objectContaining({ code: "conflicting_effects" }),
    );

    // Disjoint Monday vs Tuesday lane layouts with overlapping outer dates are compatible
    const monVsTue = situation("mon-vs-tue", {
      kind: "closure",
      type: "closure",
      subtype: "lane",
      validity: {
        status: "active",
        start: "2026-09-01T00:00:00+02:00",
        end: "2026-09-30T23:59:00+02:00",
      },
      effects: [
        effect("l-mon", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          lanes: [
            { index: 1, status: "closed" },
            { index: 2, status: "open" },
          ],
          validity: {
            status: "active",
            start: "2026-09-01T00:00:00+02:00",
            end: "2026-09-30T23:59:00+02:00",
            periods: [
              {
                repeatFrequency: "P1W",
                byDay: ["MO"],
                startTime: "08:00",
                duration: "PT4H",
                scheduleTimezone: "Europe/Berlin",
              },
            ],
          },
        }),
        effect("l-tue", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          lanes: [
            { index: 1, status: "open" },
            { index: 2, status: "closed" },
          ],
          validity: {
            status: "active",
            start: "2026-09-01T00:00:00+02:00",
            end: "2026-09-30T23:59:00+02:00",
            periods: [
              {
                repeatFrequency: "P1W",
                byDay: ["TU"],
                startTime: "08:00",
                duration: "PT4H",
                scheduleTimezone: "Europe/Berlin",
              },
            ],
          },
        }),
      ],
    });
    const monTueOut = cifsIncidentsOf(monVsTue, AT);
    expect(monTueOut).toHaveLength(2);
    expect(monTueOut.map((i) => i.schedule)).toEqual([
      { monday: "08:00-12:00" },
      { tuesday: "08:00-12:00" },
    ]);
  });

  it("withholds DST-crossing schedules, enforces code-point lengths, disambiguates split IDs, emits parent_event, and avoids over-specific codes", () => {
    // Spring & autumn DST-crossing schedules withheld
    for (const [id, start, end] of [
      ["spring-dst", "2026-03-28T00:00:00+01:00", "2026-03-30T23:59:00+02:00"],
      ["autumn-dst", "2026-10-24T00:00:00+02:00", "2026-10-26T23:59:00+01:00"],
    ] as const) {
      const dstSit = situation(id, {
        validity: {
          status: "active",
          start,
          end,
          periods: [
            {
              repeatFrequency: "P1W",
              byDay: ["SU"],
              startTime: "01:00",
              duration: "PT3H",
              scheduleTimezone: "Europe/Berlin",
            },
          ],
        },
      });
      expect(cifsIncidentsOf(dstSit, new Date(start))).toEqual([]);
    }

    // Single supplementary Unicode character street has length 2 in UTF-16 but 1 code point → withheld
    const emojiStreet = situation("emoji-street", {
      location: {
        geometry: LINE,
        roads: [{ name: [{ lang: "und", text: "🚧" }] }],
        direction: { value: "positive", basis: "geometry" },
      },
    });
    expect(cifsIncidentsOf(emojiStreet, AT)).toEqual([]);

    // Split ID colliding with another situation's root ID is disambiguated across the feed
    const sitA = situation("A", {
      effects: [
        effect("part", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          validity: {
            status: "active",
            start: "2026-09-06T09:00:00Z",
            end: "2026-09-06T12:00:00Z",
          },
        }),
      ],
    });
    const sitAPart = situation("A#part");
    const feed = situationsToCifsJson([sitA, sitAPart], AT);
    expect(feed.incidents.length).toBeGreaterThanOrEqual(3);
    expect(new Set(feed.incidents.map((i) => i.id)).size).toBe(feed.incidents.length);

    // Preserved cifs:parent_event is emitted in JSON and XML
    const withParent = situation("with-parent", {
      externalIds: [{ scheme: "cifs:parent_event", id: "marathon-2026" }],
    });
    const [parentJson] = situationsToCifsJson([withParent], AT).incidents;
    expect(parentJson?.parent_event).toEqual({ id: "marathon-2026" });
    expect(situationsToCifsXml([withParent], AT)).toContain('<parent_event id="marathon-2026"/>');

    // Non-over-specific crosswalk codes
    const [storm] = cifsIncidentsOf(
      situation("storm", { kind: "weather_condition", type: "weather", subtype: "storm" }),
      AT,
    );
    expect(storm).toMatchObject({ type: "HAZARD", subtype: "HAZARD_WEATHER" });
    const [obstruction] = cifsIncidentsOf(
      situation("obstruction", { kind: "incident", type: "obstruction" }),
      AT,
    );
    expect(obstruction).toMatchObject({ type: "HAZARD", subtype: "HAZARD_ON_ROAD" });
    const [obj] = cifsIncidentsOf(
      situation("object", { kind: "incident", type: "obstruction", subtype: "object" }),
      AT,
    );
    expect(obj).toMatchObject({ type: "HAZARD", subtype: "HAZARD_ON_ROAD_OBJECT" });
  });

  it("enforces strict lane consistency, intersects bounded weekly occurrences, and keeps IDs XML-safe and poll-stable", () => {
    // all_lanes_closed with mixed open/closed lanes emits neither HAZARD_ON_ROAD_LANE_CLOSED nor <lanes>
    const mixedAllClosed = situation("mixed-all-closed", {
      kind: "closure",
      type: "closure",
      subtype: "lane",
      effects: [
        effect("l1", "lane_restriction", {
          vehicleImpact: "all_lanes_closed",
          lanes: [
            { index: 1, status: "closed" },
            { index: 2, status: "open" },
          ],
        }),
      ],
    });
    expect(cifsIncidentsOf(mixedAllClosed, AT)).toEqual([]);

    // all_lanes_open_shift_left does not emit HAZARD_ON_ROAD_LANE_CLOSED
    const shiftLeft = situation("shift-left", {
      kind: "closure",
      type: "closure",
      subtype: "lane",
      effects: [effect("l1", "lane_restriction", { vehicleImpact: "all_lanes_open_shift_left" })],
    });
    expect(cifsIncidentsOf(shiftLeft, AT)).toEqual([]);

    // lanesRestricted: 0 with a closed lane does not emit HAZARD_ON_ROAD_LANE_CLOSED or <lanes>
    const zeroRestricted = situation("zero-restricted", {
      kind: "closure",
      type: "closure",
      subtype: "lane",
      effects: [
        effect("l1", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          lanesRestricted: 0,
          lanes: [
            { index: 1, status: "closed" },
            { index: 2, status: "open" },
          ],
        }),
      ],
    });
    expect(cifsIncidentsOf(zeroRestricted, AT)).toEqual([]);

    // Two Monday-only schedules in Europe/Berlin whose outer bounds overlap only on Wed-Thu
    // have zero overlapping occurrences and must both be emitted
    const disjointMondays = situation("disjoint-mondays", {
      kind: "closure",
      type: "closure",
      subtype: "lane",
      validity: {
        status: "active",
        start: "2026-09-07T00:00:00+02:00",
        end: "2026-09-14T23:59:00+02:00",
      },
      effects: [
        effect("mon-1", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          lanes: [
            { index: 1, status: "closed" },
            { index: 2, status: "open" },
          ],
          validity: {
            status: "active",
            start: "2026-09-07T00:00:00+02:00",
            end: "2026-09-10T23:59:00+02:00",
            periods: [
              {
                repeatFrequency: "P1W",
                byDay: ["MO"],
                startTime: "08:00",
                duration: "PT4H",
                scheduleTimezone: "Europe/Berlin",
              },
            ],
          },
        }),
        effect("mon-2", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          lanes: [
            { index: 1, status: "open" },
            { index: 2, status: "closed" },
          ],
          validity: {
            status: "active",
            start: "2026-09-09T00:00:00+02:00",
            end: "2026-09-14T23:59:00+02:00",
            periods: [
              {
                repeatFrequency: "P1W",
                byDay: ["MO"],
                startTime: "08:00",
                duration: "PT4H",
                scheduleTimezone: "Europe/Berlin",
              },
            ],
          },
        }),
      ],
    });
    const disjointOut = cifsIncidentsOf(disjointMondays, new Date("2026-09-07T09:00:00+02:00"));
    expect(disjointOut).toHaveLength(2);

    // Tab vs space in situation IDs remain distinct after XML attribute normalization
    const tabSit = situation("abc\tdef");
    const spaceSit = situation("abc def");
    const wsFeed = situationsToCifsJson([tabSit, spaceSit], AT);
    const wsXml = situationsToCifsXml([tabSit, spaceSit], AT);
    expect(wsFeed.incidents.map((i) => i.id)).toEqual([
      "oc:situation:test:abc%09def",
      "oc:situation:test:abc def",
    ]);
    expect(wsXml).toContain('id="oc:situation:test:abc%09def"');
    expect(wsXml).toContain('id="oc:situation:test:abc def"');

    // Split ID of "sitA" is stable whether or not another situation with raw id "sitA#part" is present
    const sitA = situation("sitA", {
      effects: [
        effect("part", "lane_restriction", {
          vehicleImpact: "some_lanes_closed",
          validity: {
            status: "active",
            start: "2026-09-06T09:00:00Z",
            end: "2026-09-06T12:00:00Z",
          },
        }),
      ],
    });
    const sitAPart = situation("sitA#part");
    const soloIds = situationsToCifsJson([sitA], AT).incidents.map((i) => i.id);
    const pairIds = situationsToCifsJson([sitA, sitAPart], AT).incidents.map((i) => i.id);
    expect(soloIds).toEqual(["oc:situation:test:sitA", "oc:situation:test:sitA#part"]);
    expect(pairIds).toEqual([
      "oc:situation:test:sitA",
      "oc:situation:test:sitA#part",
      "oc:situation:test:sitA%23part",
    ]);
  });
});
