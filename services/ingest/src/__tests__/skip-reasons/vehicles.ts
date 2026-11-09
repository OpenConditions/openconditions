import type { SkipExemptions, SkipSamples } from "./sample.js";

export const SAMPLES: SkipSamples = {
  "vehicles/iowa-avl": {
    reason: "malformed",
    payloads: {
      main: JSON.stringify({
        spatialReference: { wkid: 4326 },
        features: [
          {
            attributes: { OBJECTID: 1, LABEL: "A35674", MODIFIEDDT: null },
            geometry: { x: -93.57, y: 42.42 },
          },
        ],
      }),
    },
  },
  // A current tracking without a position.
  "vehicles/digitraffic": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: null,
            properties: { id: 1, time: "2026-07-31T11:58:00Z", tasks: ["SALTING"] },
          },
        ],
      }),
    },
  },
};

export const EXEMPT: SkipExemptions = {};
