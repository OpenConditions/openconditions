import type { SkipExemptions, SkipSamples } from "./sample.js";

export const SAMPLES: SkipSamples = {
  "weather/cwa-weather": {
    reason: "unknown_value",
    payloads: {
      main: JSON.stringify({
        success: "true",
        result: { resource_id: "O-A0003-001" },
        records: {
          Station: [
            {
              StationId: "466940",
              ObsTime: { DateTime: "2026-07-31T19:59:00+08:00" },
              GeoInfo: {
                Coordinates: [
                  {
                    CoordinateName: "WGS84",
                    CoordinateFormat: "decimal degrees",
                    StationLongitude: "121.740475",
                    StationLatitude: "25.133314",
                  },
                ],
              },
              WeatherElement: {
                AirTemperature: "X",
                RelativeHumidity: "83",
                WindSpeed: "3.8",
                WindDirection: "50.0",
              },
            },
          ],
        },
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
