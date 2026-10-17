import type { SkipExemptions, SkipSamples } from "./sample.js";

export const SAMPLES: SkipSamples = {
  // A station of the list without a geometry.
  "cameras/digitraffic": {
    reason: "no_geometry",
    payloads: {
      sites: JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [24.0, 60.0, 0] },
            properties: { id: "C01", presets: [{ id: "C0101", inCollection: true }] },
          },
          { type: "Feature", geometry: null, properties: { id: "C02", presets: [] } },
        ],
      }),
    },
  },
  // A camera of the object API without its WGS84 geometry.
  "cameras/trafikverket": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        RESPONSE: {
          RESULT: [
            {
              Camera: [
                { Id: "SE_1", Name: "Kamera", Geometry: { WGS84: "POINT (18.06 59.33)" } },
                { Id: "SE_2", Name: "Utan plats" },
              ],
            },
          ],
        },
      }),
    },
  },
  // A camera listed without coordinates.
  "cameras/ibi511": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify([
        { Id: 1, Name: "I-75 at Exit 1", Latitude: 33.75, Longitude: -84.39, Views: [] },
        { Id: 2, Name: "Nowhere", Views: [] },
      ]),
    },
  },
  // A CCTV without its position.
  "cameras/tdx": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        CCTVs: [
          { CCTVID: "CCTV-1", PositionLon: 121.5, PositionLat: 25.03, RoadDirection: "N" },
          { CCTVID: "CCTV-2", RoadDirection: "S" },
        ],
      }),
    },
  },
  // A snapshot camera listed without coordinates.
  "cameras/hk-td": {
    reason: "no_geometry",
    payloads: {
      main: [
        "<image-list>",
        "<image><key>H1</key><description>Road [H1]</description><latitude>22.25</latitude><longitude>114.15</longitude></image>",
        "<image><key>H2</key><description>Nowhere [H2]</description></image>",
        "</image-list>",
      ].join(""),
    },
  },
  // A webcam in a status Windy does not document.
  "cameras/windy": {
    reason: "unknown_type",
    payloads: {
      main: JSON.stringify({
        webcams: [
          {
            webcamId: 1,
            title: "Innsbruck",
            status: "active",
            location: { latitude: 47.27, longitude: 11.39 },
          },
          {
            webcamId: 2,
            title: "Archived",
            status: "archived",
            location: { latitude: 47.3, longitude: 11.4 },
          },
        ],
      }),
    },
  },
  // A JamCam place without its position.
  "cameras/tfl": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify([
        { id: "JamCams_1", commonName: "A40 Westway", lat: 51.52, lon: -0.2 },
        { id: "JamCams_2", commonName: "Nowhere" },
      ]),
    },
  },
  // A webcam the list gives empty coordinates.
  "cameras/nps": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        data: [
          { id: "A", title: "Half Dome", latitude: "37.7", longitude: "-119.7", status: "Active" },
          { id: "B", title: "Nowhere", latitude: "", longitude: "", status: "Active" },
        ],
      }),
    },
  },
  // An inventory row without its position.
  "cameras/tripcheck": {
    reason: "no_geometry",
    payloads: {
      main: JSON.stringify({
        CCTVInventoryRequest: [
          {
            "device-id": 1,
            "device-name": "I-5 at Delta Park",
            latitude: 45.6,
            longitude: -122.68,
            "cctv-url": "https://tripcheck.com/RoadCams/cams/a.jpg",
          },
          { "device-id": 2, "device-name": "Nowhere" },
        ],
      }),
    },
  },
  // An inventory item without a geo-location.
  "cameras/cars-cctv": {
    reason: "no_geometry",
    payloads: {
      main: [
        "<cctvInventories><cctvInventory><inventory>",
        "<inventory-item><device-id>1</device-id><video-url>https://example.test/1.m3u8</video-url>",
        "<location><geo-location><latitude>42940992</latitude><longitude>-78766229</longitude></geo-location></location>",
        "</inventory-item>",
        "<inventory-item><device-id>2</device-id><video-url>https://example.test/2.m3u8</video-url></inventory-item>",
        "</inventory></cctvInventory></cctvInventories>",
      ].join(""),
    },
  },
};

export const EXEMPT: SkipExemptions = {};
