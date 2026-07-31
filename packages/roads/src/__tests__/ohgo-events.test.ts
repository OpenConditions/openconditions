import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseOhgoEvents } from "../ohgo-events.js";
import type { SourceDescriptor } from "../types.js";

const SRC: SourceDescriptor = {
  id: "us-oh-ohgo-construction",
  attribution: "Ohio Department of Transportation (OHGO)",
  country: "US",
  license: "US-Gov-Public-Domain",
};

const load = (name: string) =>
  readFileSync(join(import.meta.dirname, `fixtures/ohgo-oh/${name}.json`), "utf8");

describe("parseOhgoEvents — construction", () => {
  it("maps a work zone to planned roadworks with its validity window", () => {
    const [ev] = parseOhgoEvents(load("construction"), SRC);
    expect(ev).toBeDefined();
    expect(ev!.id).toBe("us-oh-ohgo-construction:OH-CON-1001");
    expect(ev!.sourceFormat).toBe("ohgo-events");
    expect(ev!.type).toBe("roadworks");
    expect(ev!.category).toBe("planned");
    expect(ev!.isPlanned).toBe(true);
    expect(ev!.validFrom).toBe("2026-06-01T05:00:00.000Z");
    expect(ev!.validTo).toBe("2026-10-15T23:00:00.000Z");
    expect(ev!.geometry).toEqual({ type: "Point", coordinates: [-82.9988, 39.9612] });
    expect(ev!.roads).toEqual([{ name: "I-70", direction: "Eastbound" }]);
    expect(ev!.roadState).toBe("some_lanes_closed");
    expect(ev!.headline).toBe("I-70 EB at Hamilton Rd");
    expect(ev!.dataUpdatedAt).toBe("2026-07-30T12:15:00.000Z");
  });

  it("maps a full closure's roadStatus to the closed road state", () => {
    const events = parseOhgoEvents(load("construction"), SRC);
    const closed = events.find((e) => e.id.endsWith("OH-CON-1002"));
    expect(closed!.roadState).toBe("closed");
  });

  it("skips a record without usable coordinates", () => {
    const events = parseOhgoEvents(load("construction"), SRC);
    expect(events.map((e) => e.id)).not.toContain("us-oh-ohgo-construction:OH-CON-NOGEO");
    expect(events).toHaveLength(2);
  });

  it("keeps the whole upstream record in sourceRaw", () => {
    const [ev] = parseOhgoEvents(load("construction"), SRC);
    expect(ev!.sourceRaw).toMatchObject({ district: "District 6", status: "Active" });
  });
});

describe("parseOhgoEvents — incidents", () => {
  const INCIDENT_SRC: SourceDescriptor = { ...SRC, id: "us-oh-ohgo-incidents" };

  it("maps the incident category table and leaves the events unplanned", () => {
    const events = parseOhgoEvents(load("incidents"), INCIDENT_SRC);
    const byId = new Map(events.map((e) => [e.id, e]));

    const crash = byId.get("us-oh-ohgo-incidents:OH-INC-2001")!;
    expect(crash.type).toBe("accident");
    expect(crash.category).toBe("incident");
    expect(crash.isPlanned).toBe(false);
    expect(crash.validFrom).toBeNull();

    expect(byId.get("us-oh-ohgo-incidents:OH-INC-2002")!.type).toBe("hazard");
  });

  it("degrades an unmapped category to `other` rather than dropping the record", () => {
    const events = parseOhgoEvents(load("incidents"), INCIDENT_SRC);
    const unmapped = events.find((e) => e.id.endsWith("OH-INC-2003"))!;
    expect(unmapped.type).toBe("other");
    expect(unmapped.subtype).toBe("Some Unmapped Category");
    expect(unmapped.roadState).toBe("closed");
  });

  it("reads a lower-case `results` envelope as well as OHGO's own `Results`", () => {
    // The published wrapper client and the live responses disagree on casing.
    expect(parseOhgoEvents(load("incidents"), INCIDENT_SRC)).toHaveLength(3);
    expect(parseOhgoEvents(load("construction"), SRC)).toHaveLength(2);
  });
});

describe("parseOhgoEvents — malformed input", () => {
  it("returns [] for unparseable JSON, a missing envelope or a non-array payload", () => {
    expect(parseOhgoEvents("not json", SRC)).toEqual([]);
    expect(parseOhgoEvents(JSON.stringify({ nothing: true }), SRC)).toEqual([]);
    expect(parseOhgoEvents(JSON.stringify({ Results: "nope" }), SRC)).toEqual([]);
    expect(parseOhgoEvents(JSON.stringify([]), SRC)).toEqual([]);
  });
});
