import type { SkipExemptions, SkipSamples } from "./sample.js";

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
