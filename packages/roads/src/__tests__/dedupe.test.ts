import { describe, expect, it } from "vitest";
import { dedupeRoadEvents, dropSupersededRoadEvents } from "../dedupe.js";
import type { RoadEvent } from "../model.js";

function makeRoadEvent(overrides: Partial<RoadEvent> & { lng: number; lat: number }): RoadEvent {
  const { lng, lat, ...rest } = overrides;
  return {
    id: `road-${Math.random().toString(36).slice(2)}`,
    source: "test-source",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    type: "accident",
    subtype: undefined,
    category: "incident",
    severity: "medium",
    severitySource: "declared",
    headline: "Accident",
    isPlanned: false,
    roads: [],
    geometry: { type: "Point", coordinates: [lng, lat] },
    status: "active",
    origin: {
      kind: "feed",
      attribution: { provider: "Test", license: "CC0-1.0" },
    },
    dataUpdatedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
    isStale: false,
    ...rest,
  };
}

describe("dedupeRoadEvents", () => {
  it("merges two RoadEvents at the same coords with the same type", () => {
    const a = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "accident" });
    const b = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "accident" });

    const result = dedupeRoadEvents([a, b]);
    expect(result).toHaveLength(1);
  });

  it("keeps the same one of duplicates updated at once, whichever order they come in", () => {
    const a = makeRoadEvent({ id: "src:a", lng: 4.9, lat: 52.3 });
    const b = makeRoadEvent({ id: "src:b", lng: 4.9, lat: 52.3 });

    expect(dedupeRoadEvents([a, b]).map((e) => e.id)).toEqual(["src:a"]);
    expect(dedupeRoadEvents([b, a]).map((e) => e.id)).toEqual(["src:a"]);
  });

  it("keeps two RoadEvents at the same coords with different types separate", () => {
    const a = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "accident" });
    const b = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "roadworks" });

    const result = dedupeRoadEvents([a, b]);
    expect(result).toHaveLength(2);
  });

  it("keeps same-type events at the same coords with dissimilar headlines separate", () => {
    // Road events carry their text in `headline` (not `label`), so the within-
    // source text guard must compare headlines — otherwise two unrelated works
    // reported at the same coordinate wrongly collapse into one.
    const a = makeRoadEvent({
      lng: 4.9,
      lat: 52.3,
      type: "roadworks",
      headline: "Resurfacing northbound lane between Tempo Road and Clearwater",
    });
    const b = makeRoadEvent({
      lng: 4.9,
      lat: 52.3,
      type: "roadworks",
      headline: "Bridge joint replacement southbound ramp closure detour",
    });

    const result = dedupeRoadEvents([a, b]);
    expect(result).toHaveLength(2);
  });

  it("still merges genuine duplicates with near-identical headlines", () => {
    const headline = "Daily construction on HWY 17 eastbound between Terrace and Schreiber";
    const a = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "roadworks", headline });
    const b = makeRoadEvent({ lng: 4.9, lat: 52.3, type: "roadworks", headline });

    const result = dedupeRoadEvents([a, b]);
    expect(result).toHaveLength(1);
  });

  it("merges two events 20 m apart, keeping the one updated last", () => {
    const older = makeRoadEvent({ lng: 4.9, lat: 52.3, dataUpdatedAt: "2026-01-01T10:00:00Z" });
    const newer = makeRoadEvent({
      lng: 4.900178,
      lat: 52.3,
      dataUpdatedAt: "2026-01-01T12:00:00Z",
    });

    const result = dedupeRoadEvents([older, newer]);
    expect(result).toHaveLength(1);
    expect(result[0]!.dataUpdatedAt).toBe("2026-01-01T12:00:00Z");
  });

  it("keeps two events 500 m apart separate", () => {
    const a = makeRoadEvent({ lng: 4.9, lat: 52.3 });
    const b = makeRoadEvent({ lng: 4.9, lat: 52.3045 });

    expect(dedupeRoadEvents([a, b])).toHaveLength(2);
  });

  it("does not over-merge a transitive A-B-C chain when A-C exceeds the distance threshold", () => {
    // At lat 52.3, 1° lng ≈ 67 930 m: A–B ≈ 40 m, B–C ≈ 40 m, A–C ≈ 80 m (> 60 m).
    // Only the all-pairs guard keeps the chain from collapsing into one.
    const A = makeRoadEvent({ lng: 4.9, lat: 52.3 });
    const B = makeRoadEvent({ lng: 4.900589, lat: 52.3 });
    const C = makeRoadEvent({ lng: 4.901178, lat: 52.3 });

    expect(dedupeRoadEvents([A, B, C])).toHaveLength(2);
  });

  describe("keeps events at one place with one text apart when they say different things", () => {
    const at = { lng: 4.9, lat: 52.3, type: "roadworks" as const, headline: "Lane closed" };
    const PAIRS: [string, Partial<RoadEvent>, Partial<RoadEvent>][] = [
      ["directions", { direction: "northbound" }, { direction: "southbound" }],
      [
        "directions on their roads",
        { roads: [{ name: "I-80", direction: "eastbound" }] },
        { roads: [{ name: "I-80", direction: "westbound" }] },
      ],
      [
        "occurrences",
        { validFrom: "2026-03-01T20:00:00Z", validTo: "2026-03-02T05:00:00Z" },
        { validFrom: "2026-03-02T20:00:00Z", validTo: "2026-03-03T05:00:00Z" },
      ],
      [
        "schedules",
        { schedule: [{ byDay: ["MO"], scheduleTimezone: "UTC" }] },
        { schedule: [{ byDay: ["TU"], scheduleTimezone: "UTC" }] },
      ],
      ["a forecast and a current event", { isForecast: true }, {}],
      [
        "lanes",
        { lanesAffected: { total: 2, closed: 1, lanes: [{ index: 1, status: "closed" }] } },
        { lanesAffected: { total: 2, closed: 1, lanes: [{ index: 2, status: "closed" }] } },
      ],
      ["vehicles", { vehiclesAffected: ["truck"] }, { vehiclesAffected: ["bus"] }],
      [
        "restrictions",
        { restrictions: [{ type: "reduced-height", value: 4, unit: "m" }] },
        { restrictions: [{ type: "reduced-height", value: 3.5, unit: "m" }] },
      ],
      ["speed limits", { speedLimitKph: 60 }, { speedLimitKph: 80 }],
      ["road states", { roadState: "closed" }, { roadState: "some_lanes_closed" }],
      ["subtypes", { subtype: "resurfacing" }, { subtype: "bridge_work" }],
      ["roads", { roads: [{ name: "Main St" }] }, { roads: [{ name: "Oak Ave" }] }],
      [
        "descriptions that differ by a word",
        { description: "Auffahrt auf die A2: AS Bornstedt gesperrt" },
        { description: "Abfahrt von der A2: AS Bornstedt gesperrt" },
      ],
    ];

    it.each(PAIRS)("%s", (_, a, b) => {
      expect(
        dedupeRoadEvents([makeRoadEvent({ ...at, ...a }), makeRoadEvent({ ...at, ...b })]),
      ).toHaveLength(2);
    });
  });

  it("folds a copy that leaves out what the other states, and copies alike in what both state", () => {
    const at = { lng: 4.9, lat: 52.3, type: "roadworks" as const, headline: "Lane closed" };
    const full = {
      direction: "Northbound",
      validFrom: "2026-03-01T20:00:00Z",
      roads: [{ name: "I 80", ref: "I-80" }],
      lanesAffected: { total: 2, closed: 1 },
    };
    expect(
      dedupeRoadEvents([makeRoadEvent({ ...at, ...full }), makeRoadEvent({ ...at })]),
    ).toHaveLength(1);
    expect(
      dedupeRoadEvents([
        makeRoadEvent({ ...at, ...full }),
        makeRoadEvent({
          ...at,
          ...full,
          direction: "northbound ",
          validFrom: "2026-03-01T21:00:00+01:00",
          roads: [{ name: "I80" }],
        }),
      ]),
    ).toHaveLength(1);
  });

  it("folds copies whose descriptions differ only in spacing and case, or that one leaves out", () => {
    const at = { lng: 4.9, lat: 52.3, type: "roadworks" as const, headline: "Lane closed" };
    const description = "Right lane blocked.\r\nDetour in place.";
    expect(
      dedupeRoadEvents([
        makeRoadEvent({ ...at, description }),
        makeRoadEvent({ ...at, description: "  right lane blocked. detour IN place. " }),
      ]),
    ).toHaveLength(1);
    expect(
      dedupeRoadEvents([makeRoadEvent({ ...at, description }), makeRoadEvent({ ...at })]),
    ).toHaveLength(1);
  });

  it("returns an empty array for no events", () => {
    expect(dedupeRoadEvents([])).toEqual([]);
  });
});

describe("dropSupersededRoadEvents", () => {
  const at = (id: string, updated: string, over: Partial<RoadEvent> & { lng?: number } = {}) =>
    makeRoadEvent({ id, lng: 100.96, lat: 13.86, dataUpdatedAt: updated, ...over });
  const original = at("src:1", "2026-06-26T01:17:46Z", { description: "Accident blocking lanes" });
  const progress = at("src:3", "2026-06-26T01:21:48Z", { description: "Car was moved" });
  const ids = (events: RoadEvent[], followUps: RoadEvent[]) =>
    dropSupersededRoadEvents(events, (e) => followUps.includes(e)).map((e) => e.id);

  it("replaces the earlier events of its type around it, earlier follow-ups included", () => {
    const firstProgress = at("src:2", "2026-06-26T01:19:00Z", { description: "Police on site" });
    expect(ids([original, firstProgress, progress], [firstProgress, progress])).toEqual(["src:3"]);
  });

  it("reads the time the source stated before the time it was read", () => {
    const stated = at("src:1", "2026-06-26T09:00:00Z", {
      situation: { sourceUpdatedAt: "2026-06-26T01:00:00Z" },
    });
    expect(ids([stated, progress], [progress])).toEqual(["src:3"]);
  });

  it("keeps a later event, another type, and an event beyond the fold distance", () => {
    const later = at("src:4", "2026-06-26T02:00:00Z");
    const breakdown = at("src:5", "2026-06-26T01:00:00Z", { type: "roadworks" });
    const away = at("src:6", "2026-06-26T01:00:00Z", { lng: 100.962 });
    expect(ids([later, breakdown, away, progress], [progress])).toEqual([
      "src:4",
      "src:5",
      "src:6",
      "src:3",
    ]);
  });

  it("keeps an event of another source type that maps to the same coarse type", () => {
    const congestion = at("src:4", "2026-06-26T01:00:00Z", { type: "other", subtype: "10" });
    const movedOn = at("src:5", "2026-06-26T01:20:00Z", { type: "other", subtype: "1" });
    expect(ids([congestion, movedOn], [movedOn])).toEqual(["src:4", "src:5"]);
  });

  it("replaces an original updated at the same instant, but not another follow-up", () => {
    const sameTime = at("src:7", progress.dataUpdatedAt);
    const otherProgress = at("src:8", progress.dataUpdatedAt);
    expect(ids([sameTime, progress], [progress])).toEqual(["src:3"]);
    expect(ids([otherProgress, progress], [otherProgress, progress])).toEqual(["src:8", "src:3"]);
  });

  it("neither replaces nor is replaced without a time", () => {
    const undated = at("src:9", "not a time");
    expect(ids([undated, progress], [progress])).toEqual(["src:9", "src:3"]);
    const undatedProgress = { ...progress, dataUpdatedAt: "" };
    expect(ids([original, undatedProgress], [undatedProgress])).toEqual(["src:1", "src:3"]);
  });
});
