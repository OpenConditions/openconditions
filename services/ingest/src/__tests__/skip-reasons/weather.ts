import { readFileSync } from "node:fs";
import { buildZip } from "../helpers/zip.js";
import type { SkipExemptions, SkipSamples } from "./sample.js";

const station =
  "00044 20070208 20260731             44     52.9336    8.2370 " +
  "Großenkneten".padEnd(41) +
  "Niedersachsen".padEnd(41) +
  "Frei";
const metadata =
  "Stations_id von_datum bis_datum Stationshoehe geoBreite geoLaenge Stationsname Bundesland Abgabe\n-----\n" +
  station;
const zip = (role: string, fields: string, values: string, id = "00044") =>
  buildZip([
    {
      name: `produkt_zehn_now_${role}_20260731_20260731_${id}.txt`,
      data: `STATIONS_ID;MESS_DATUM;QN;${fields};eor\n${Number(id)};202607311150;3;${values};eor\n`,
    },
  ]);
const at = Date.parse("2026-07-31T12:00:00Z");
const parameters = [
  ["1", "celsius"],
  ["39", "celsius"],
  ["6", "procent"],
  ["12", "meter"],
  ["3", "grader"],
  ["4", "meter per sekund"],
  ["21", "meter per sekund"],
  ["7", "millimeter"],
] as const;
const smhiStation = {
  key: "123",
  name: "Test",
  owner: "SMHI",
  measuringStations: "CORE",
  active: true,
  longitude: 18,
  latitude: 60,
  from: 0,
  to: at,
};
export const SAMPLES: SkipSamples = {
  "weather/eccc-swob": {
    reason: "unknown_type",
    payloads: {
      sites: JSON.stringify({
        type: "FeatureCollection",
        numberMatched: 1,
        numberReturned: 1,
        links: [],
        features: [
          {
            type: "Feature",
            id: "outside",
            geometry: { type: "Point", coordinates: [-63, 44] },
            properties: { msc_id: "outside", data_provider: "DFO", dataset_network: "CA" },
          },
        ],
      }),
      status: JSON.stringify({
        type: "FeatureCollection",
        numberMatched: 0,
        numberReturned: 0,
        links: [],
        features: [],
      }),
    },
  },
  "weather/smhi-metobs": {
    reason: "unknown_value",
    payloads: {
      sites: parameters.map(([key, unit]) =>
        JSON.stringify({ key, unit, updated: at, valueType: "SAMPLING", station: [smhiStation] }),
      ),
      status: parameters.map(([key, unit]) =>
        JSON.stringify({
          parameter: { key, unit },
          updated: at,
          period: { key: "latest-hour", from: at - 3599000, to: at },
          station: [
            { ...smhiStation, value: key === "1" ? [{ date: at, value: "0", quality: "R" }] : [] },
          ],
        }),
      ),
    },
  },

  "weather/dwd-cdc-10min": {
    reason: "no_geometry",
    payloads: {
      tu_stations: metadata,
      ff_stations: metadata,
      fx_stations: metadata,
      rr_stations: metadata,
      tu: [
        zip("tu", "TT_10;TD_10;RF_10", "4;2;90"),
        zip("tu", "TT_10;TD_10;RF_10", "4;2;90", "99999"),
      ],
      ff: [zip("ff", "FF_10;DD_10", "1;50")],
      fx: [zip("fx", "FX_10", "2")],
      rr: [zip("rr", "RWS_10", "0")],
    },
  },
  "weather/fmi-weather": {
    reason: "unknown_type",
    payloads: {
      sites: readFileSync(
        new URL(
          "../../../../../packages/weather/src/__tests__/fixtures/fmi/station-101004.xml",
          import.meta.url,
        ),
        "utf8",
      ).replace("Finland", "Norway"),
    },
  },
  // A listed station without a position.
  "weather/digitraffic-weather": {
    reason: "no_geometry",
    payloads: {
      sites: JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: null,
            properties: { id: 1001, name: "vt1_Espoo_Nupuri", collectionStatus: "GATHERING" },
          },
        ],
      }),
    },
  },
};

export const EXEMPT: SkipExemptions = {};
