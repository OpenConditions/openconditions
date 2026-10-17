import type { SkipExemptions, SkipSamples } from "./sample.js";

const point = { type: "Point", coordinates: [10, 50] };
/** A decoded station registry holding the one station `known`. */
const registry = { sites: new Map([["known", { geometry: point }]]) };

export const SAMPLES: SkipSamples = {
  "roads/digitraffic-traffic-measurement": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({ features: [{ geometry: null, properties: { id: "1" } }] }),
    },
  },
  "roads/datex2-elaborated": {
    reason: "no_geometry",
    payloads: {
      main: `<d2LogicalModel><payloadPublication><elaboratedData><basicData><pertinentLocation><predefinedLocationReference id="unknown"/></pertinentLocation><averageVehicleSpeed><speed>80</speed></averageVehicleSpeed></basicData></elaboratedData></payloadPublication></d2LogicalModel>`,
    },
    reference: registry,
  },
  "roads/fintraffic-tms": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        stations: [
          {
            id: "unknown",
            sensorValues: [{ name: "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1", value: 80 }],
          },
        ],
      }),
    },
    reference: registry,
  },
  "roads/webtris": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        Rows: [
          {
            "Site Name": "5607/1",
            "Report Date": "2026-07-31T00:00:00",
            "Time Period Ending": "12:00:00",
            "Avg mph": "50",
            "Total Volume": "10",
          },
        ],
      }),
    },
    reference: registry,
  },
  "roads/nyc-dot": {
    reason: "no_geometry",
    payloads: { main: JSON.stringify([{ link_id: "1", speed: "30" }]) },
  },
  "roads/ohgo": {
    reason: "no_geometry",
    payloads: { main: JSON.stringify({ Results: [{ Id: "1", CurrentAvgSpeed: 50 }] }) },
  },
  "roads/trafikverket-flow": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        RESPONSE: { RESULT: [{ TrafficFlow: [{ SiteId: 1, AverageVehicleSpeed: 80 }] }] },
      }),
    },
  },
  "roads/bonn": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        features: [{ geometry: null, properties: { strecke_id: 1, geschwindigkeit: 30 } }],
      }),
    },
  },
  "roads/informo": {
    reason: "no_geometry",
    payloads: {
      main: "<pms><pm><idelem>1</idelem><nivelServicio>1</nivelServicio><error>N</error></pm></pms>",
    },
  },
  "roads/lta-speedbands": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({ value: [{ LinkID: 1, MinimumSpeed: 10, MaximumSpeed: 20 }] }),
    },
  },
  "roads/miv": {
    reason: "no_geometry",
    payloads: {
      main: `<miv><meetpunt unieke_id="unknown"><meetdata klasse_id="2"><verkeersintensiteit>3</verkeersintensiteit><voertuigsnelheid_harmonisch>80</voertuigsnelheid_harmonisch></meetdata></meetpunt></miv>`,
    },
    reference: registry,
  },
  "roads/fdt": {
    reason: "no_geometry",
    payloads: {
      main: `<traffic_data generation_time="2026-07-31T12:00:00Z"><FDT_data lcd1="1" accuracy="95" period="5"><speedflow flow="360" speed="54"/></FDT_data></traffic_data>`,
    },
  },
  "roads/hk-td": {
    reason: "no_geometry",
    payloads: {
      main: `<raw_speed_volume_list><date>2026-07-31</date><periods><period><period_from>20:00:00</period_from><period_to>20:00:30</period_to><detectors><detector><detector_id>unknown</detector_id><lanes><lane><lane_id>Fast Lane</lane_id><speed>60</speed><volume>2</volume><occupancy>5</occupancy><valid>Y</valid></lane></lanes></detector></detectors></period></periods></raw_speed_volume_list>`,
    },
    reference: registry,
  },
  "roads/geojson-flow": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: null, properties: { id: "1", speed: 40 } }],
      }),
    },
    feed: { flowMap: { idField: "id", speedField: "speed" } },
  },
  "roads/bcn-trams": {
    reason: "no_geometry",
    payloads: { main: "unknown#20260731140000#2#2" },
    reference: registry,
  },
};

export const EXEMPT: SkipExemptions = {};
