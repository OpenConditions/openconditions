import type { SkipExemptions, SkipSamples } from "./sample.js";

const point = { type: "Point", coordinates: [8.68, 50.11] };

/** Samples of the roads event formats and the sign format. */
export const SAMPLES: SkipSamples = {
  "roads/open511": {
    reason: "unknown_value",
    payloads: {
      main: JSON.stringify({
        events: [{ id: "e1", status: "PAUSED", event_type: "INCIDENT", geography: point }],
      }),
    },
  },
  "roads/geojson": {
    reason: "unknown_value",
    feed: {
      geojson: { idField: "id", typeField: "kind", typeMap: { accident: "accident" } },
    },
    payloads: {
      main: JSON.stringify({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { id: "f1", kind: "meteor" }, geometry: point }],
      }),
    },
  },
  "roads/cars": {
    reason: "unknown_value",
    payloads: {
      main: JSON.stringify([
        {
          "event-id": "e1",
          headline: { code: "meteor strike" },
          details: [{ access: "PUBLIC_DOMAIN" }],
          geometry: point,
        },
      ]),
    },
  },
  "roads/ibi511": {
    reason: "unknown_value",
    payloads: {
      main: JSON.stringify([
        { ID: 1, EventType: "meteorStrike", Latitude: 43.6, Longitude: -79.4 },
      ]),
    },
  },
  "roads/ibi511-conditions": {
    reason: "malformed",
    // A record that is no object has no fields to read.
    payloads: { main: JSON.stringify([null]) },
  },
  "roads/lta": {
    reason: "unknown_value",
    payloads: {
      main: JSON.stringify({
        value: [{ Type: "Meteor", Latitude: 1.3, Longitude: 103.8, Message: "x" }],
      }),
    },
  },
  "roads/gddkia": {
    reason: "unknown_value",
    payloads: {
      main: `<?xml version="1.0"?><utrudnienia><utr><typ>X</typ><geo_lat>52.2</geo_lat><geo_long>21.0</geo_long></utr></utrudnienia>`,
    },
  },
  "roads/flatjson": {
    reason: "malformed",
    feed: { geojson: { idField: "id", lonField: "lon", latField: "lat" } },
    // A row that is no object has no fields to map.
    payloads: { main: JSON.stringify([7, { id: "r1", lon: 100.5, lat: 13.7 }]) },
  },
  "roads/trafikverket": {
    reason: "malformed",
    // Neither the deviation nor its situation names an id.
    payloads: {
      main: JSON.stringify({
        RESPONSE: {
          RESULT: [
            {
              Situation: [
                {
                  Deviation: [
                    { MessageType: "Olycka", Message: "x", Geometry: { WGS84: "POINT (18 59)" } },
                  ],
                },
              ],
            },
          ],
        },
      }),
    },
  },
  "roads/autobahn": {
    reason: "unknown_value",
    payloads: {
      main: JSON.stringify({
        warning: [
          {
            identifier: "w1",
            title: "A5 | x",
            display_type: "METEOR",
            coordinate: { lat: "50.1", long: "8.6" },
          },
        ],
      }),
    },
  },
  "roads/digitraffic": {
    reason: "malformed",
    // A feature with no situationId has no stable identity.
    payloads: {
      main: JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: point,
            properties: { situationType: "TRAFFIC_ANNOUNCEMENT", announcements: [] },
          },
        ],
      }),
    },
  },
  "roads/ohgo-events": {
    reason: "malformed",
    payloads: {
      main: JSON.stringify({ Results: [{ latitude: 40.0, longitude: -83.0, description: "x" }] }),
    },
  },
  "roads/vic-disruptions": {
    reason: "malformed",
    payloads: {
      main: JSON.stringify({ disruptions: [{ name: "x", geometry: point }] }),
    },
  },
  "roads/cars-signs": {
    reason: "malformed",
    payloads: {
      main: JSON.stringify([{ name: "x", location: { latitude: 42.7, longitude: -73.8 } }]),
    },
  },
};

export const EXEMPT: SkipExemptions = {};
