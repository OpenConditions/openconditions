import { describe, expect, it } from "vitest";
import { parseFintrafficFlow } from "../flow-fintraffic.js";
import type { SourceDescriptor } from "../types.js";
import type { SiteGeometry } from "../siteTable.js";

const src = {
  id: "fintraffic-tms-fi",
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
          name: "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1",
          sensorValue: 95,
          sensorUnit: "km/h",
          measuredTime: "2026-03-04T14:30:00Z",
        },
        {
          name: "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA2",
          sensorValue: 42,
          sensorUnit: "km/h",
          measuredTime: "2026-03-04T14:30:00Z",
        },
        {
          name: "OHITUKSET_60MIN_KIINTEA_SUUNTA1",
          sensorValue: 700,
          sensorUnit: "kpl/h",
          measuredTime: "2026-03-04T14:30:00Z",
        },
      ],
    },
    {
      id: 999999,
      dataUpdatedTime: "2026-03-04T14:30:00Z",
      sensorValues: [
        {
          name: "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1",
          sensorValue: 80,
          sensorUnit: "km/h",
          measuredTime: "2026-03-04T14:30:00Z",
        },
      ],
    },
  ],
});

describe("parseFintrafficFlow", () => {
  it("emits one flow per direction with a 5-min avg speed and geometry", () => {
    const { flows, events } = parseFintrafficFlow(payload, src, siteMap);
    expect(flows.map((f) => f.id).sort()).toEqual([
      "fintraffic-tms-fi:23001-1",
      "fintraffic-tms-fi:23001-2",
    ]);
    const dir1 = flows.find((f) => f.id.endsWith("-1"))!;
    expect(dir1.speedKph).toBe(95);
    expect(dir1.los).toBe("unknown");
    expect(dir1.direction).toBe("SUUNTA1");
    expect(dir1.geometry).toEqual({ type: "Point", coordinates: [24.9, 60.2] });
    expect(dir1.sourceFormat).toBe("fintraffic-tms-json");
    const dir2 = flows.find((f) => f.id.endsWith("-2"))!;
    expect(dir2.direction).toBe("SUUNTA2");
    expect(events).toEqual([]);
  });

  it("skips stations with no geometry in the registry", () => {
    const { flows } = parseFintrafficFlow(payload, src, siteMap);
    expect(flows.some((f) => f.id.startsWith("fintraffic-tms-fi:999999"))).toBe(false);
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
