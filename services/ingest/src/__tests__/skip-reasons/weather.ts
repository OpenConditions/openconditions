import { readFileSync } from "node:fs";
import type { SkipExemptions, SkipSamples } from "./sample.js";

export const SAMPLES: SkipSamples = {
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
