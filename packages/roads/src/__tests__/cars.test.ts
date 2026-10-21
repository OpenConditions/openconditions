import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCars, parseCarsSnapshot } from "../cars.js";
import { situationDrafts } from "../situation/assemble.js";
import type { SourceDescriptor } from "../types.js";

const SRC: SourceDescriptor = {
  id: "us-ny-511-events",
  attribution: "511NY / New York State DOT",
  country: "US",
  license: "LicenseRef-511NY-DAA",
  timeZone: "America/New_York",
};

const load = (name: string) =>
  readFileSync(join(import.meta.dirname, `fixtures/cars-ny/${name}.json`));

const FETCHED = "2026-10-14T00:00:00.000Z";

describe("CARS events with values of the wrong shape", () => {
  type Rec = Record<string, unknown>;
  const events = () => JSON.parse(load("events").toString("utf8")) as Rec[];
  const locationOf = (ev: Rec) => ((ev["details"] as Rec[])[0]!["locations"] as Rec[])[0] as Rec;

  it("counts an event whose fields are of other JSON types as malformed, not the response", () => {
    const doc = events();
    doc[1]!["status"] = 3;
    const report = parseCarsSnapshot(JSON.stringify(doc), SRC, { fetchedAt: FETCHED });
    expect(report.inputCount).toBe(7);
    expect(report.records).toHaveLength(6);
    expect(report.errors).toEqual([{ code: "malformed_record", id: null, sourcePath: "$[1]" }]);
  });

  it("reads a route designator only as text, and never as an inherited key", () => {
    const doc = events();
    locationOf(doc[1]!)["route-designator"] = 87;
    locationOf(doc[2]!)["route-designator"] = "constructor";
    locationOf(doc[2]!)["link-alignment"] = "toString";
    const read = parseCars(JSON.stringify(doc), SRC);
    expect(read.find((e) => e.id.endsWith("TEST-1002"))!.roads).toEqual([]);
    expect(read.find((e) => e.id.endsWith("TEST-1003"))!.roads?.[0]?.direction).toBeUndefined();
    expect(() => situationDrafts(read, { source: SRC })).not.toThrow();
  });

  it("holds an event whose geometry is no valid GeoJSON as unlocatable", () => {
    const doc = events();
    doc[1]!["geometry"] = { type: "Point", coordinates: [-73.78, 142.85] };
    const report = parseCarsSnapshot(JSON.stringify(doc), SRC, { fetchedAt: FETCHED });
    expect(report.records.find((r) => r.id.endsWith("TEST-1002"))!.disposition).toBe("unlocatable");
  });
});

describe("parseCarsSnapshot", () => {
  it("accounts for every event: ended and withheld ones are terminal, one without a place unlocatable", () => {
    const report = parseCarsSnapshot(load("events"), SRC, { fetchedAt: FETCHED });
    expect(report.inputCount).toBe(7);
    expect(report.errors).toEqual([]);
    expect(Object.fromEntries(report.records.map((r) => [r.id, r.disposition]))).toEqual({
      "us-ny-511-events:TEST-1001": "accepted",
      "us-ny-511-events:TEST-1002": "accepted",
      "us-ny-511-events:TEST-1003": "accepted",
      "us-ny-511-events:TEST-1004": "accepted",
      "us-ny-511-events:TEST-1005": "terminal",
      "us-ny-511-events:TEST-1006": "terminal",
      "us-ny-511-events:TEST-1007": "unlocatable",
    });
    expect(report.records.find((r) => r.id.endsWith("TEST-1005"))).toMatchObject({
      version: 2,
      versionTime: "2026-10-09T23:53:20.000Z",
    });
  });

  it("reads a winter segment that reports nothing adverse as ended, an adverse one as its condition", () => {
    const report = parseCarsSnapshot(load("conditions"), SRC, { fetchedAt: FETCHED });
    expect(report.records.map((r) => r.disposition)).toEqual(["terminal", "accepted"]);
    const snow = report.records[1]!.event!;
    expect(snow.situation?.classification).toEqual({
      kind: "road_condition",
      type: "surface",
      subtype: "snow_covered",
    });
    expect(snow).toMatchObject({ category: "conditions", validFrom: null, validTo: null });
  });

  it("refuses a body that is no event array", () => {
    expect(parseCarsSnapshot(Buffer.from('{"code":401}'), SRC).errors).toEqual([
      { code: "invalid_envelope", id: null, sourcePath: "$" },
    ]);
    expect(parseCarsSnapshot(Buffer.from("<html>"), SRC).errors[0]?.code).toBe("invalid_json");
  });
});

describe("parseCars", () => {
  const events = parseCars(load("events"), SRC);
  const byId = (id: string) => events.find((e) => e.id === `us-ny-511-events:${id}`)!;

  it("returns the current events only", () => {
    expect(events.map((e) => e.id.split(":")[1]).sort()).toEqual([
      "TEST-1001",
      "TEST-1002",
      "TEST-1003",
      "TEST-1004",
    ]);
  });

  it("classifies by the first phrase that names a nature and keeps the publisher's texts", () => {
    const works = byId("TEST-1001");
    expect(works.situation?.classification).toEqual({
      kind: "roadworks",
      type: "works",
      subtype: "maintenance",
    });
    expect(works).toMatchObject({ type: "roadworks", category: "planned", isPlanned: true });
    expect(works.headline).toBe("NY 7 in both directions: Road maintenance operations");
    expect(works.description).toMatch(
      /^NY 7 in both directions: Road maintenance operations\. between/,
    );
    expect(works.situation?.comments).toEqual([
      {
        type: "public",
        text: [
          {
            lang: "en",
            text: "Web Text: milling and paving between Exit 4 and Exit 5, weather permitting, Monday thru Friday, 09:00 AM thru 04:00 PM, alternating traffic",
          },
        ],
      },
    ]);
    expect(works.regions).toEqual(["Schenectady"]);
    expect(works.roads).toEqual([{ name: "NY 7", direction: "both directions" }]);
    expect(works.geometry.type).toBe("LineString");
  });

  it("reads the recurring times as weekly windows in the event's zone", () => {
    expect(byId("TEST-1001").schedule).toEqual([
      {
        repeatFrequency: "P1W",
        startDate: "2026-10-18T13:00:00.000Z",
        endDate: "2026-10-30T20:00:00.000Z",
        startTime: "09:00",
        endTime: "16:00",
        duration: "PT7H",
        byDay: ["MO", "TU", "WE", "TH", "FR"],
        scheduleTimezone: "America/New_York",
      },
    ]);
  });

  it("names the travel direction from the link's alignment, else the route's positive direction", () => {
    // NEGATIVE on a northbound-aligned link.
    expect(byId("TEST-1002")).toMatchObject({ direction: "southbound", roadState: "closed" });
    // POSITIVE on I-90, whose positive direction NYSDOT gives as east.
    expect(byId("TEST-1003").direction).toBe("eastbound");
  });

  it("states the closed lanes, a shoulder taking none", () => {
    expect(byId("TEST-1002").lanesAffected).toEqual({ total: 3, closed: 3 });
    expect(byId("TEST-1003")).toMatchObject({
      roadState: "some_lanes_closed",
      lanesAffected: {
        total: 3,
        closed: 1,
        lanes: [
          { index: 1, status: "open" },
          { index: 2, status: "open" },
          { index: 3, status: "closed" },
        ],
      },
    });
  });

  it("declares severity by 511NY's priority crosswalk", () => {
    expect(byId("TEST-1003")).toMatchObject({ severity: "high", severitySource: "declared" });
    expect(byId("TEST-1002").severity).toBe("medium");
    expect(byId("TEST-1001").severity).toBe("low");
    expect(byId("TEST-1003").situation?.severityRaw).toBe("1");
  });

  it("places an event at a landmark by its geometry, with no road", () => {
    const concert = byId("TEST-1004");
    expect(concert.situation?.classification).toEqual({
      kind: "public_event",
      type: "event",
      subtype: "concert",
    });
    expect(concert.roads).toEqual([]);
    expect(concert.geometry).toEqual({ type: "Point", coordinates: [-73.75, 42.65] });
  });
});
