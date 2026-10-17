import type { SkipExemptions, SkipSamples } from "./sample.js";

export const SAMPLES: SkipSamples = {
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
