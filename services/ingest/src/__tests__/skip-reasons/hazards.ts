import type { SkipExemptions, SkipSamples } from "./sample.js";

const json = (value: unknown) => JSON.stringify(value);

const IRWIN = "{11111111-2222-3333-4444-555555555555}";
const SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [10, 40],
      [10.1, 40],
      [10.1, 40.1],
      [10, 40],
    ],
  ],
};

export const SAMPLES: SkipSamples = {
  // A detection row with no position at all.
  "hazards/firms": {
    reason: "no_geometry",
    payloads: {
      main: [
        "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight",
        ",,300,0.4,0.4,2026-07-31,0305,N21,nominal,2.0NRT,280,2.5,D",
        "",
      ].join("\n"),
    },
  },
  "hazards/slstr-frp": {
    reason: "no_geometry",
    payloads: {
      granules: json({ type: "FeatureCollection", features: [] }),
      fires: [
        "#title = SLSTR Level 2 Product, Fire Radiative Power (FRP) measurement, Near Real Time (NRT)",
        "lat(deg),lon(deg),day,time,D/N,FRP(MW),FRPerr(MW),used_channel,confidence(%),confidence_class(lower=0;nominal=1;higher=2),MWIR_BT(K),IFOV_area(m2),SZA(deg),VZA(deg),actrack(km),altrack(km),satellite",
        ",,2026-07-31,03:05:00,D,2.5,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,S3A",
        "",
      ].join("\n"),
    },
  },
  // An incident whose point the register has not set.
  "hazards/wfigs": {
    reason: "no_geometry",
    payloads: {
      incidents: json({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { IrwinID: IRWIN, IncidentTypeCategory: "WF", IncidentName: "Test" },
            geometry: null,
          },
        ],
      }),
    },
  },
  "hazards/effis": {
    reason: "no_geometry",
    payloads: {
      main: json({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { id: "820007", FIREDATE: "2026-07-30 10:00:00", COUNTRY: "EL" },
            geometry: null,
          },
        ],
      }),
    },
  },
  // A smoke density the format does not know.
  "hazards/hms": {
    reason: "unknown_value",
    payloads: {
      main: json({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { FID: 1, Density: "Extreme", Start: "2026212 1200", End_: "2026212 1300" },
            geometry: SQUARE,
          },
        ],
      }),
    },
  },
  "hazards/usgs": {
    reason: "no_geometry",
    payloads: {
      recent: json({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "us7000test",
            properties: { type: "earthquake", time: 1785499200000, mag: 4.2 },
            geometry: null,
          },
        ],
      }),
      window: json({ type: "FeatureCollection", features: [] }),
    },
  },
  // An event of a category EONET has added since.
  "hazards/eonet": {
    reason: "unknown_type",
    payloads: {
      open: json({
        events: [
          {
            id: "EONET_1",
            title: "Meteor",
            categories: [{ id: "meteors", title: "Meteors" }],
            sources: [],
            geometry: [{ date: "2026-07-30T00:00:00Z", type: "Point", coordinates: [10, 40] }],
          },
        ],
      }),
    },
  },
};

export const EXEMPT: SkipExemptions = {};
