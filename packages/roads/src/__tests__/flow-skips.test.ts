import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, it } from "vitest";
import { parseDigitrafficFlow } from "../flow.js";
import { parseBcnTramsFlow } from "../flow-bcn.js";
import { parseBonnFlow } from "../flow-bonn.js";
import { parseElaboratedFlow } from "../flow-elaborated.js";
import { parseFintrafficFlow } from "../flow-fintraffic.js";
import { parseGeojsonFlow } from "../flow-geojson.js";
import { parseLtaSpeedBands } from "../flow-lta-speedbands.js";
import { parseMadridFlow } from "../flow-madrid.js";
import { parseNycDotFlow } from "../flow-nycdot.js";
import { parseOhgoFlow } from "../flow-ohgo.js";
import type { FlowSites } from "../flow-output.js";
import { parseTrafikverketFlow } from "../flow-trafikverket.js";
import { parseTurinFlow } from "../flow-turin.js";
import { parseWebtrisFlow } from "../flow-webtris.js";
import { parseHkRawFlow } from "../hk.js";
import { parseMivFlow } from "../miv.js";
import type { SourceDescriptor } from "../types.js";
import { CTX } from "./flow-fixtures.js";

const ID = "xx-flow-skips";
const src: SourceDescriptor = {
  id: ID,
  attribution: "t",
  country: "XX",
  license: "CC0-1.0",
  timeZone: "Europe/Berlin",
};
const point = { type: "Point" as const, coordinates: [10, 50] as [number, number] };
const sites = (...ids: string[]): FlowSites => new Map(ids.map((id) => [id, { geometry: point }]));
const json = (v: unknown) => JSON.stringify(v);

/**
 * Every flow parser records what it drops, and what it keeps without a value
 * it cannot read: the flow pipeline counts nothing else as rejected.
 */
describe("flow parsers record their skips", () => {
  beforeEach(() => __resetSkips());

  it("digitraffic: a segment without line geometry, an unknown congestion level", () => {
    const line = {
      type: "LineString",
      coordinates: [
        [24, 60],
        [24.1, 60.1],
      ],
    };
    const out = parseDigitrafficFlow(
      json({
        features: [
          { geometry: null, properties: { id: "a" } },
          { geometry: { type: "Point", coordinates: [24, 60] }, properties: { id: "b" } },
          {
            geometry: line,
            properties: { id: "c", congestionLevel: "GRIDLOCK", averageSpeed: 50 },
          },
          { geometry: line, properties: { id: "d", congestionLevel: "UNKNOWN", averageSpeed: 50 } },
        ],
      }),
      src,
      undefined,
      CTX,
    );
    expect(out.readings.map((r) => [r.site, r.los])).toEqual([
      ["c", "unknown"],
      ["d", "unknown"],
    ]);
    expect(drainSkipped(ID)).toEqual({ no_geometry: 2, unknown_value: 1 });
  });

  it("bcn-trams: an unregistered segment, a status off the scale; sensor-down rows are no skips", () => {
    const out = parseBcnTramsFlow(
      [
        "1#20260729131557#2#2",
        "2#20260729131557#0#0",
        "3#20260729131557#9#9",
        "999#20260729131557#3#3",
        "x",
      ].join("\n"),
      src,
      sites("1", "2", "3"),
      CTX,
    );
    expect(out.readings.map((r) => r.site)).toEqual(["1"]);
    expect(drainSkipped(ID)).toEqual({ malformed: 2, no_geometry: 1 });
  });

  it("bcn-trams: an error page skips nothing", () => {
    expect(parseBcnTramsFlow("<html>error</html>", src, sites("1"), CTX).failed).toBe(true);
    expect(drainSkipped(ID)).toEqual({});
  });

  it("bonn: no id, no line, nothing readable, an unread phrase beside a speed", () => {
    const line = {
      type: "LineString",
      coordinates: [
        [7, 50.7],
        [7.1, 50.71],
      ],
    };
    const out = parseBonnFlow(
      json({
        features: [
          { geometry: line, properties: { verkehrsstatus: "frei" } },
          { geometry: null, properties: { strecke_id: 1, verkehrsstatus: "frei" } },
          { geometry: line, properties: { strecke_id: 2, verkehrsstatus: "???" } },
          {
            geometry: line,
            properties: { strecke_id: 3, verkehrsstatus: "???", geschwindigkeit: 30 },
          },
          { geometry: line, properties: { strecke_id: 4, verkehrsstatus: "nicht ermittelbar" } },
        ],
      }),
      src,
      undefined,
      CTX,
    );
    expect(out.readings.map((r) => r.site)).toEqual(["3"]);
    expect(drainSkipped(ID)).toEqual({ malformed: 2, no_geometry: 1, unknown_value: 1 });
  });

  it("fintraffic-tms: a station the registry does not hold, one without an id", () => {
    const sensor = { name: "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1", value: 80 };
    parseFintrafficFlow(
      json({
        stations: [{ id: 1, sensorValues: [sensor] }, { id: 2, sensorValues: [sensor] }, {}],
      }),
      src,
      sites("1"),
      CTX,
    );
    expect(drainSkipped(ID)).toEqual({ no_geometry: 1, malformed: 1 });
  });

  it("geojson-flow: no geometry, a broken line, an unread status with and without a speed", () => {
    const feedSrc: SourceDescriptor = {
      ...src,
      flowMap: { idField: "id", speedField: "speed", statusField: "status" },
    };
    const geometry = { type: "Point", coordinates: [1, 47] };
    const out = parseGeojsonFlow(
      json({
        features: [
          { geometry: null, properties: { id: "a", speed: 40 } },
          {
            geometry: { type: "LineString", coordinates: [[1, 47]] },
            properties: { id: "b", speed: 40 },
          },
          { geometry, properties: { id: "c", status: "jammed" } },
          { geometry, properties: { id: "d", status: "jammed", speed: 40 } },
          { geometry, properties: { id: "e", status: "unknown" } },
        ],
      }),
      feedSrc,
      undefined,
      CTX,
    );
    expect(out.readings.map((r) => r.site)).toEqual(["d"]);
    expect(drainSkipped(ID)).toEqual({ no_geometry: 1, malformed: 2, unknown_value: 1 });
  });

  it("lta-speedbands: no id, no coordinates, a broken coordinate, no band", () => {
    const at = { StartLon: 103.8, StartLat: 1.3, EndLon: 103.81, EndLat: 1.31 };
    const out = parseLtaSpeedBands(
      json({
        value: [
          { ...at, MinimumSpeed: 10, MaximumSpeed: 20 },
          { LinkID: 1, MinimumSpeed: 10, MaximumSpeed: 20 },
          { LinkID: 2, ...at, EndLat: "x", MinimumSpeed: 10, MaximumSpeed: 20 },
          { LinkID: 3, ...at },
          { LinkID: 4, ...at, MinimumSpeed: 10, MaximumSpeed: 20 },
        ],
      }),
      src,
      undefined,
      CTX,
    );
    expect(out.readings.map((r) => r.site)).toEqual(["4"]);
    expect(drainSkipped(ID)).toEqual({ malformed: 3, no_geometry: 1 });
  });

  it("informo: no coordinate, a level off the scale; faults and unstated levels are no skips", () => {
    const pm = (id: string, extra: string) =>
      `<pm><idelem>${id}</idelem><error>N</error>${extra}</pm>`;
    const xy = "<st_x>440000</st_x><st_y>4474000</st_y>";
    const out = parseMadridFlow(
      `<pms>${pm("1", "<nivelServicio>1</nivelServicio>")}${pm("2", `${xy}<nivelServicio>7</nivelServicio>`)}${pm("3", xy)}<pm><idelem>4</idelem><error>S</error></pm>${pm("5", `${xy}<nivelServicio>1</nivelServicio>`)}</pms>`,
      src,
      undefined,
      CTX,
    );
    expect(out.readings.map((r) => r.site)).toEqual(["5"]);
    expect(drainSkipped(ID)).toEqual({ no_geometry: 1, malformed: 1 });
  });

  it("nyc-dot: no polyline, an unreadable speed; an absent speed is no skip", () => {
    const link_points = "40.7,-74 40.71,-74.01";
    const out = parseNycDotFlow(
      json([
        { link_id: "1", speed: "30" },
        { link_id: "2", speed: "fast", link_points },
        { link_id: "3", link_points },
        { link_id: "4", speed: "30", link_points },
      ]),
      src,
      undefined,
      CTX,
    );
    expect(out.readings.map((r) => r.site)).toEqual(["4"]);
    expect(drainSkipped(ID)).toEqual({ no_geometry: 1, malformed: 1 });
  });

  it("ohgo: no position, no speed; a null position is not 0,0", () => {
    const out = parseOhgoFlow(
      json({
        Results: [
          { Id: "1", Latitude: null, Longitude: null, CurrentAvgSpeed: 50 },
          { Id: "2", Latitude: 40, Longitude: -83 },
          { Id: "3", Latitude: 40, Longitude: -83, CurrentAvgSpeed: 50 },
        ],
      }),
      src,
      undefined,
      CTX,
    );
    expect(out.readings.map((r) => r.site)).toEqual(["3"]);
    expect(drainSkipped(ID)).toEqual({ no_geometry: 1, malformed: 1 });
  });

  it("trafikverket-flow: no point, an unreadable point", () => {
    parseTrafikverketFlow(
      json({
        RESPONSE: {
          RESULT: [
            {
              TrafficFlow: [
                { SiteId: 1, AverageVehicleSpeed: 80 },
                { SiteId: 2, AverageVehicleSpeed: 80, Geometry: { WGS84: "POINT (x y)" } },
              ],
            },
          ],
        },
      }),
      src,
      undefined,
      CTX,
    );
    expect(drainSkipped(ID)).toEqual({ no_geometry: 1, malformed: 1 });
  });

  it("fdt: no coordinate, no speed; unconfident detectors are no skips", () => {
    const out = parseTurinFlow(
      `<traffic_data generation_time="2026-07-10T18:00:03Z">
        <FDT_data lcd1="1" accuracy="95"><speedflow flow="1" speed="50"/></FDT_data>
        <FDT_data lcd1="2" accuracy="95" lat="45" lng="7.6"><speedflow flow="1"/></FDT_data>
        <FDT_data lcd1="3" accuracy="0" lat="45" lng="7.6"><speedflow flow="0" speed="0"/></FDT_data>
      </traffic_data>`,
      src,
      undefined,
      CTX,
    );
    expect(out.readings).toEqual([]);
    expect(drainSkipped(ID)).toEqual({ no_geometry: 1, malformed: 1 });
  });

  it("webtris: a row without a site number, a site the registry does not hold (once)", () => {
    const row = (site: string, ending: string) => ({
      "Site Name": site,
      "Report Date": "2026-03-04T00:00:00",
      "Time Period Ending": ending,
      "Avg mph": "50",
      "Total Volume": "10",
    });
    const out = parseWebtrisFlow(
      json({
        Rows: [
          row("Unnamed", "10:00:00"),
          row("1/1", "10:00:00"),
          row("2/1", "10:00:00"),
          row("2/1", "10:15:00"),
        ],
      }),
      src,
      sites("1"),
      CTX,
    );
    expect(out.readings.map((r) => r.site)).toEqual(["1"]);
    expect(drainSkipped(ID)).toEqual({ malformed: 1, no_geometry: 1 });
  });

  it("hk-td: a detector the registry does not hold", () => {
    const detector = (id: string) =>
      `<detector><detector_id>${id}</detector_id><lanes><lane><lane_id>Fast Lane</lane_id><speed>60</speed><volume>2</volume><occupancy>5</occupancy><valid>Y</valid></lane></lanes></detector>`;
    const out = parseHkRawFlow(
      `<raw_speed_volume_list><date>2026-07-10</date><periods><period><period_from>10:00:00</period_from><period_to>10:00:30</period_to><detectors>${detector("A")}${detector("B")}</detectors></period></periods></raw_speed_volume_list>`,
      src,
      sites("A"),
      CTX,
    );
    expect(out.readings.map((r) => r.site)).toEqual(["A"]);
    expect(drainSkipped(ID)).toEqual({ no_geometry: 1 });
  });

  it("miv: an unconfigured point, a class it does not map; defects are no skips", () => {
    const data = (cls: string) =>
      `<meetdata klasse_id="${cls}"><verkeersintensiteit>3</verkeersintensiteit><voertuigsnelheid_harmonisch>80</voertuigsnelheid_harmonisch></meetdata>`;
    const out = parseMivFlow(
      `<miv><meetpunt unieke_id="1">${data("2")}${data("9")}</meetpunt><meetpunt unieke_id="2">${data("2")}</meetpunt><meetpunt unieke_id="3"><defect>1</defect></meetpunt></miv>`,
      src,
      sites("1", "3"),
      CTX,
    );
    expect(out.readings.map((r) => [r.site, r.classSpeeds])).toEqual([["1", { car: 80 }]]);
    expect(drainSkipped(ID)).toEqual({ no_geometry: 1, unknown_value: 1 });
  });

  it("datex2-elaborated: no location, an unplaced site, an unread status", () => {
    const item = (ref: string | undefined, basic: string) =>
      `<elaboratedData><basicData>${ref ? `<pertinentLocation><predefinedLocationReference id="${ref}"/></pertinentLocation>` : ""}${basic}</basicData></elaboratedData>`;
    const speed = "<averageVehicleSpeed><speed>80</speed></averageVehicleSpeed>";
    const status = (v: string) =>
      `<trafficStatus><trafficStatusValue>${v}</trafficStatusValue></trafficStatus>`;
    const out = parseElaboratedFlow(
      `<d2LogicalModel><payloadPublication>${item(undefined, speed)}${item("unplaced", speed)}${item("a", `${speed}${status("gridlock")}`)}${item("b", status("gridlock"))}${item("c", status("unknown"))}</payloadPublication></d2LogicalModel>`,
      src,
      sites("a", "b", "c"),
      CTX,
    );
    expect(out.readings.map((r) => [r.site, r.los])).toEqual([["a", "unknown"]]);
    expect(drainSkipped(ID)).toEqual({ no_geometry: 2, unknown_value: 1, malformed: 1 });
  });
});
