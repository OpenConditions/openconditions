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
export const SAMPLES: SkipSamples = {
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
