import type { SkipExemptions, SkipSamples } from "./sample.js";

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
const station = {
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
  "weather/smhi-metobs": {
    reason: "unknown_value",
    payloads: {
      sites: parameters.map(([key, unit]) =>
        JSON.stringify({ key, unit, updated: at, valueType: "SAMPLING", station: [station] }),
      ),
      status: parameters.map(([key, unit]) =>
        JSON.stringify({
          parameter: { key, unit },
          updated: at,
          period: { key: "latest-hour", from: at - 3599000, to: at },
          station: [
            { ...station, value: key === "1" ? [{ date: at, value: "0", quality: "R" }] : [] },
          ],
        }),
      ),
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
