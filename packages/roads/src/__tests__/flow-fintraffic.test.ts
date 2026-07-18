import { describe, expect, it } from "vitest";
import { parseFintrafficFlow } from "../flow-fintraffic.js";
import type { SourceDescriptor } from "../types.js";
import type { SiteGeometry } from "../siteTable.js";

const src = {
  id: "fi-fintraffic",
  attribution: "Fintraffic",
  country: "FI",
  license: "CC-BY-4.0",
} as SourceDescriptor;

const siteMap = new Map<string, SiteGeometry>([
  ["23001", { type: "Point", coordinates: [24.9, 60.2] }],
]);

const payload = JSON.stringify({
  dataUpdatedTime: "2026-03-04T14:30:00Z",
  stations: [
    {
      id: 23001,
      dataUpdatedTime: "2026-03-04T14:30:00Z",
      sensorValues: [
        {
          id: 5016,
          stationId: 23001,
          name: "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1",
          measuredTime: "2026-03-04T14:30:00Z",
          unit: "km/h",
          value: 95,
        },
        {
          id: 5017,
          stationId: 23001,
          name: "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA2",
          measuredTime: "2026-03-04T14:30:00Z",
          unit: "km/h",
          value: 42,
        },
        {
          id: 5033,
          stationId: 23001,
          name: "OHITUKSET_60MIN_KIINTEA_SUUNTA1",
          measuredTime: "2026-03-04T14:30:00Z",
          unit: "kpl/h",
          value: 700,
        },
      ],
    },
    {
      id: 999999,
      dataUpdatedTime: "2026-03-04T14:30:00Z",
      sensorValues: [
        {
          id: 5016,
          stationId: 999999,
          name: "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1",
          measuredTime: "2026-03-04T14:30:00Z",
          unit: "km/h",
          value: 80,
        },
      ],
    },
  ],
});

describe("parseFintrafficFlow", () => {
  it("emits one flow per direction with a 5-min avg speed and geometry", () => {
    const { flows, events } = parseFintrafficFlow(payload, src, siteMap);
    expect(flows.map((f) => f.id).sort()).toEqual([
      "fi-fintraffic:23001-1",
      "fi-fintraffic:23001-2",
    ]);
    const dir1 = flows.find((f) => f.id.endsWith("-1"))!;
    expect(dir1.speedKph).toBe(95);
    expect(dir1.los).toBe("unknown");
    expect(dir1.direction).toBe("SUUNTA1");
    expect(dir1.geometry).toEqual({ type: "Point", coordinates: [24.9, 60.2] });
    expect(dir1.sourceFormat).toBe("fintraffic-tms");
    const dir2 = flows.find((f) => f.id.endsWith("-2"))!;
    expect(dir2.direction).toBe("SUUNTA2");
    expect(events).toEqual([]);
  });

  it("skips stations with no geometry in the registry", () => {
    const { flows } = parseFintrafficFlow(payload, src, siteMap);
    expect(flows.some((f) => f.id.startsWith("fi-fintraffic:999999"))).toBe(false);
  });

  it("returns empty on malformed input", () => {
    expect(parseFintrafficFlow("not json", src, siteMap)).toEqual({ flows: [], events: [] });
  });

  it("handles a station with absent sensorValues gracefully", () => {
    const noSensors = JSON.stringify({
      stations: [{ id: 23001, sensorValues: undefined }],
    });
    expect(parseFintrafficFlow(noSensors, src, siteMap)).toEqual({ flows: [], events: [] });
  });

  it("returns empty when stations is missing entirely", () => {
    expect(parseFintrafficFlow(JSON.stringify({ dataUpdatedTime: "now" }), src, siteMap)).toEqual({
      flows: [],
      events: [],
    });
  });
});
