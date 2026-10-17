import { readFileSync } from "node:fs";
import { drainSkipped } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { parseDatexSituations, parseDatexSnapshot } from "../datex.js";
import { parseDatexMeasuredData } from "../measuredData.js";
import { parseDatexSiteTable } from "../siteTable.js";
import type { SourceDescriptor } from "../types.js";
import {
  DATEX_TEST_SOURCE,
  datexDocument,
  measuredDocument,
  parseMeasured,
  parseRecord,
} from "./helpers/datex-records.js";

/**
 * What the DATEX II situation and measured-data parsers leave unread is
 * counted per source and reason: records dropped (no geometry, a type or
 * version the parser does not read, a record that breaks the format) and
 * values of kept records the parser cannot map.
 */
const read = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
const SOURCE: SourceDescriptor = {
  id: "xx-datex-skips",
  country: "XX",
  attribution: "test",
  license: "CC0-1.0",
};

describe.each(["v2", "v3"] as const)("DATEX %s situation skips", (version) => {
  it("counts nothing for a record it reads whole", () => {
    const { events, skipped } = parseRecord(version, {
      recordClass: "Accident",
      body: "<:accidentType>collision</:accidentType>",
      causeType: "accident",
      severity: "high",
    });
    expect(events).toHaveLength(1);
    expect(skipped).toEqual({});
  });

  it("drops a record class neither version defines as an unknown type", () => {
    const { events, skipped } = parseRecord(version, { recordClass: "NationalRoadworks" });
    expect(events).toEqual([]);
    expect(skipped).toEqual({ unknown_type: 1 });
  });

  it("drops a record without a class or an id as malformed", () => {
    expect(parseRecord(version, { recordClass: null })).toMatchObject({
      events: [],
      skipped: { malformed: 1 },
    });
    expect(parseRecord(version, { recordClass: "Accident", noId: true })).toMatchObject({
      events: [],
      skipped: { malformed: 1 },
    });
  });

  it("drops every record of a model version it does not read", () => {
    const { events, skipped } = parseRecord(version, {
      recordClass: "Accident",
      modelBaseVersion: "1",
    });
    expect(events).toEqual([]);
    expect(skipped).toEqual({ unsupported_version: 1 });
  });

  it("drops a record it cannot place as having no geometry", () => {
    const { events, skipped } = parseRecord(version, { recordClass: "Accident", noGeometry: true });
    expect(events).toEqual([]);
    expect(skipped).toEqual({ no_geometry: 1 });
  });

  it("keeps a record and counts each value it cannot map", () => {
    const { events, event, skipped } = parseRecord(version, {
      recordClass: "Accident",
      body: "<:accidentType>vehicleOnFire</:accidentType>",
      causeType: "meteorStrike",
      severity: "extreme",
      probability: "maybe",
      validityStatus: "pending",
    });
    expect(events).toHaveLength(1);
    expect(event?.situation?.classification).toMatchObject({ kind: "incident", type: "accident" });
    expect(skipped).toEqual({ unknown_value: 5 });
  });

  it("counts a known value once per record that carries it", () => {
    const { skipped } = parseRecord(version, {
      recordClass: "Accident",
      body: "<:accidentType>collision</:accidentType><:accidentType>notAnAccidentType</:accidentType>",
    });
    expect(skipped).toEqual({ unknown_value: 1 });
  });
});

describe("DATEX v3 `_extended` values", () => {
  it("keeps the record with its class's meaning and counts each placeholder unread", () => {
    const { event, skipped } = parseRecord("v3", {
      recordClass: "Accident",
      body: '<:accidentType _extendedValue="nationalAccident">_extended</:accidentType>',
      causeType: "_extended",
      severity: "_extended",
      probability: "_extended",
      validityStatus: "_extended",
    });
    expect(event?.situation?.classification).toMatchObject({ kind: "incident", type: "accident" });
    expect(event?.subtype).toBe("Accident");
    expect(event?.situation?.statusIssue?.code).toBe("unsupported_status");
    expect(skipped).toEqual({ unknown_value: 5 });
  });
});

describe("DATEX complete snapshots", () => {
  it("holds a record of an unknown type as unlocatable, so its situation is not ended", () => {
    drainSkipped(DATEX_TEST_SOURCE.id);
    const report = parseDatexSnapshot(
      datexDocument("v3", { recordClass: "NationalRoadworks" }),
      DATEX_TEST_SOURCE,
    );
    expect(report.errors).toEqual([]);
    expect(report.records).toMatchObject([{ disposition: "unlocatable", situationId: "S1" }]);
    expect(drainSkipped(DATEX_TEST_SOURCE.id)).toEqual({ unknown_type: 1 });
  });

  it("refuses a snapshot of a model version it does not read", () => {
    drainSkipped(DATEX_TEST_SOURCE.id);
    const report = parseDatexSnapshot(
      datexDocument("v2", { recordClass: "Accident", modelBaseVersion: "1" }),
      DATEX_TEST_SOURCE,
    );
    expect(report.errors).toEqual([
      { code: "unsupported_version", id: null, sourcePath: "modelBaseVersion" },
    ]);
    expect(drainSkipped(DATEX_TEST_SOURCE.id)).toEqual({ unsupported_version: 1 });
  });
});

describe("DATEX situation fixtures lose nothing they do not count", () => {
  it.each([
    ["cita-lu/situations.xml", 7],
    ["dgt-es/situations.xml", 9],
    ["dir-fr/situations.xml", 8],
    ["flanders-be/situations.xml", 4],
    ["hc-hr/events.datex3.xml", 3],
    ["ndw/actueel_beeld.xml", 853],
    ["ndw/restrictions-v3.xml", 6],
    ["vild/ndw-method2-points.xml", 9],
  ])("%s: %i events, nothing skipped", (path, count) => {
    drainSkipped(SOURCE.id);
    expect(parseDatexSituations(read(path), SOURCE)).toHaveLength(count);
    expect(drainSkipped(SOURCE.id)).toEqual({});
  });
});

const SPEED = {
  type: "TrafficSpeed",
  body: `<:averageVehicleSpeed numberOfInputValuesUsed="10"><:speed>87</:speed></:averageVehicleSpeed>`,
};
const TRAVEL_TIME = {
  type: "TravelTimeData",
  body: "<:travelTime><:duration>120</:duration></:travelTime>",
};
const status = (value: string) => ({
  type: "TrafficStatus",
  body: `<:trafficStatus><:trafficStatusValue>${value}</:trafficStatusValue></:trafficStatus>`,
});

describe.each(["v2", "v3"] as const)("DATEX %s measured-data skips", (version) => {
  it("counts nothing for a site it reads whole", () => {
    const { readings, skipped } = parseMeasured(version, [SPEED, status("heavy")]);
    expect(readings).toHaveLength(1);
    expect(skipped).toEqual({});
  });

  it("keeps a site and counts each value of a type the reading has no place for", () => {
    const { readings, skipped } = parseMeasured(version, [SPEED, TRAVEL_TIME, TRAVEL_TIME]);
    expect(readings).toHaveLength(1);
    expect(skipped).toEqual({ unknown_value: 2 });
  });

  it("drops a site whose every value is of such a type as an unknown type", () => {
    const { readings, skipped } = parseMeasured(version, [TRAVEL_TIME]);
    expect(readings).toEqual([]);
    expect(skipped).toEqual({ unknown_type: 1 });
  });

  it("counts a traffic status no level of service reads", () => {
    expect(parseMeasured(version, [SPEED, status("gridlock")]).skipped).toEqual({
      unknown_value: 1,
    });
    // A site that states nothing but such a status says nothing usable.
    expect(parseMeasured(version, [status("gridlock")])).toMatchObject({
      readings: [],
      skipped: { malformed: 1 },
    });
  });

  it("drops a site it cannot place as having no geometry", () => {
    const { readings, skipped } = parseMeasured(version, [SPEED], { noGeometry: true });
    expect(readings).toEqual([]);
    expect(skipped).toEqual({ no_geometry: 1 });
  });

  it("drops every site of a model version it does not read", () => {
    const { readings, failed, skipped } = parseMeasured(version, [SPEED], {
      modelBaseVersion: "4",
    });
    expect(readings).toEqual([]);
    expect(failed).toBeUndefined();
    expect(skipped).toEqual({ unsupported_version: 1 });
  });

  it("drops a site the site table holds in another revision as having no geometry", () => {
    drainSkipped(DATEX_TEST_SOURCE.id);
    const sites = new Map([
      ["S1", { geometry: { type: "Point" as const, coordinates: [4.89, 52.37] }, version: "2" }],
    ]);
    const { readings } = parseDatexMeasuredData(
      measuredDocument(version, [SPEED], { noGeometry: true }),
      DATEX_TEST_SOURCE,
      sites,
      { now: "2026-09-18T08:02:00Z", cadenceSec: 60 },
    );
    expect(readings).toEqual([]);
    expect(drainSkipped(DATEX_TEST_SOURCE.id)).toEqual({ no_geometry: 1 });
  });
});

describe("DATEX measured-data fixtures lose nothing they do not count", () => {
  it.each([
    ["ndw-flow/trafficspeed.xml", "ndw-flow/measurement_site_table.xml", 3, { no_geometry: 2 }],
    ["ndw-flow-v3/measurements.xml", "ndw-flow-v3/sites.xml", 2, {}],
    ["autobahn-bab-datex2/measured.xml", "autobahn-bab-datex2/verortung.xml", 1, {}],
    ["datex-measured-data/measured_data.xml", undefined, 3, {}],
  ] as const)("%s", (path, table, count, skipped) => {
    drainSkipped(SOURCE.id);
    const { readings } = parseDatexMeasuredData(
      read(path),
      SOURCE,
      table === undefined ? undefined : parseDatexSiteTable(read(table)),
      { now: "2026-10-16T10:00:00Z", cadenceSec: 60 },
    );
    expect(readings).toHaveLength(count);
    expect(drainSkipped(SOURCE.id)).toEqual(skipped);
  });
});
