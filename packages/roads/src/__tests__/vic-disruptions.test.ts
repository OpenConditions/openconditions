import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseVicDisruptions } from "../vic-disruptions.js";
import type { SourceDescriptor } from "../types.js";

const PLANNED: SourceDescriptor = {
  id: "au-vic-transportvic-planned",
  attribution: "Department of Transport and Planning (Victoria)",
  country: "AU",
  license: "CC-BY-4.0",
};
const UNPLANNED: SourceDescriptor = { ...PLANNED, id: "au-vic-transportvic-unplanned" };

const load = (name: string) =>
  readFileSync(join(import.meta.dirname, `fixtures/vic-au/${name}.json`), "utf8");

describe("parseVicDisruptions — planned v1", () => {
  it("maps a planned disruption to roadworks with its validity window and impact", () => {
    const [ev] = parseVicDisruptions(load("planned"), PLANNED);
    expect(ev).toBeDefined();
    expect(ev!.id).toBe("au-vic-transportvic-planned:PLN-90001");
    expect(ev!.sourceFormat).toBe("vic-disruptions");
    expect(ev!.type).toBe("roadworks");
    expect(ev!.category).toBe("planned");
    expect(ev!.isPlanned).toBe(true);
    expect(ev!.validFrom).toBe("2026-08-03T09:00:00.000Z");
    expect(ev!.validTo).toBe("2026-08-29T05:00:00.000Z");
    expect(ev!.lanesAffected).toEqual({ closed: 2 });
    expect(ev!.speedLimitKph).toBe(40);
    expect(ev!.delaySeconds).toBe(600);
    expect(ev!.roads).toEqual([{ name: "Monash Freeway", direction: "Inbound" }]);
  });

  it("unwraps a single nested geometry out of the GeometryCollection wrapper", () => {
    const [ev] = parseVicDisruptions(load("planned"), PLANNED);
    expect(ev!.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [145.0421, -37.8512],
        [145.0688, -37.8674],
      ],
    });
  });

  it("keeps a genuine multi-shape wrapper as a GeometryCollection", () => {
    const events = parseVicDisruptions(load("planned"), PLANNED);
    const event = events.find((e) => e.id.endsWith("PLN-90002"))!;
    expect(event.geometry.type).toBe("GeometryCollection");
    expect(event.type).toBe("public_event");
  });

  it("maps a recurrence to the canonical Melbourne-local schedule", () => {
    const [ev] = parseVicDisruptions(load("planned"), PLANNED);
    expect(ev!.schedule).toEqual([
      {
        scheduleTimezone: "Australia/Melbourne",
        byDay: ["MO", "TU", "WE", "TH"],
        startDate: "2026-08-03",
        endDate: "2026-08-29",
        startTime: "21:00",
        duration: "PT8H",
      },
    ]);
  });

  it("skips a record with no usable geometry", () => {
    const events = parseVicDisruptions(load("planned"), PLANNED);
    expect(events.map((e) => e.id)).not.toContain("au-vic-transportvic-planned:PLN-NOGEO");
    expect(events).toHaveLength(2);
  });

  it("warns rather than truncating silently when the feed reports more pages", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = JSON.parse(load("planned")) as { nextPageDetails: { hasMoreRecords: boolean } };
      body.nextPageDetails.hasMoreRecords = true;
      parseVicDisruptions(JSON.stringify(body), PLANNED);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("truncated"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("parseVicDisruptions — unplanned v2", () => {
  it("maps a FeatureCollection feature through the eventType crosswalk", () => {
    const events = parseVicDisruptions(load("unplanned"), UNPLANNED);
    const byId = new Map(events.map((e) => [e.id, e]));

    const crash = byId.get("au-vic-transportvic-unplanned:UNP-5001")!;
    expect(crash.type).toBe("accident");
    expect(crash.category).toBe("incident");
    expect(crash.isPlanned).toBe(false);
    expect(crash.geometry).toEqual({ type: "Point", coordinates: [144.9631, -37.8136] });
    expect(crash.roads).toEqual([{ name: "Flinders Street", direction: "Eastbound" }]);
    expect(crash.dataUpdatedAt).toBe("2026-07-31T06:40:00.000Z");
    expect(crash.validFrom).toBe("2026-07-31T06:12:00.000Z");

    expect(byId.get("au-vic-transportvic-unplanned:UNP-5002")!.type).toBe("weather");
  });

  it("skips a feature with null geometry", () => {
    const events = parseVicDisruptions(load("unplanned"), UNPLANNED);
    expect(events).toHaveLength(2);
  });
});

describe("parseVicDisruptions — malformed input", () => {
  it("returns [] for unparseable JSON or an unrecognised envelope", () => {
    expect(parseVicDisruptions("not json", PLANNED)).toEqual([]);
    expect(parseVicDisruptions(JSON.stringify({ nothing: true }), PLANNED)).toEqual([]);
    expect(parseVicDisruptions(JSON.stringify([]), PLANNED)).toEqual([]);
  });
});
