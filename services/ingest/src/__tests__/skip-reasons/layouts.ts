import type { SkipExemptions, SkipSample, SkipSamples } from "./sample.js";

const json = (doc: unknown) => JSON.stringify(doc);

const collection = (features: unknown[]) => json({ type: "FeatureCollection", features });

const placed = (id: string) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [8.54, 47.37] },
  properties: { id },
});

/** One record placed, one whose geometry is null. */
const geojsonWithoutGeometry = collection([
  placed("a"),
  { type: "Feature", geometry: null, properties: { id: "b" } },
]);

/** One record, then an element that is no object. */
const jsonWithNonObject = json([{ id: "a", lon: 8.54, lat: 47.37 }, 5]);

/** One placed row, one whose coordinates are empty. */
const csvWithoutPosition = "id,lon,lat\na,8.54,47.37\nb,,\n";

const CHARGING = { charging: { id: "id", connectors: { row: {} } } };
const PARKING = { parking: { id: "id" } };
const CAMERAS = {
  cameras: { id: "id", lang: "en", type: "traffic", imageRedistribution: "unknown" },
};

function layoutSamples(domain: string, mapping: Record<string, unknown>): SkipSamples {
  const columns = { lon: "lon", lat: "lat" };
  const samples: Record<string, SkipSample> = {
    [`${domain}/geojson`]: {
      reason: "no_geometry",
      payloads: { main: geojsonWithoutGeometry },
      feed: { layout: {}, ...mapping },
    },
    [`${domain}/json`]: {
      reason: "malformed",
      payloads: { main: jsonWithNonObject },
      feed: { layout: columns, ...mapping },
    },
    [`${domain}/csv`]: {
      reason: "no_geometry",
      payloads: { main: csvWithoutPosition },
      feed: { layout: columns, ...mapping },
    },
  };
  return samples;
}

const elements = (list: unknown[]) => json({ elements: list });

export const SAMPLES: SkipSamples = {
  ...layoutSamples("charging", CHARGING),
  ...layoutSamples("parking", PARKING),
  ...layoutSamples("cameras", CAMERAS),
  // A relation answered without its centre has no position.
  "charging/overpass": {
    reason: "no_geometry",
    payloads: {
      main: elements([
        { type: "node", id: 1, lat: 47.37, lon: 8.54, tags: { amenity: "charging_station" } },
        { type: "relation", id: 2, tags: { amenity: "charging_station" } },
      ]),
    },
  },
  "parking/overpass": {
    reason: "unknown_type",
    payloads: {
      main: elements([
        { type: "node", id: 1, lat: 47.37, lon: 8.54, tags: { amenity: "parking" } },
        { type: "area", id: 2, lat: 47.37, lon: 8.54, tags: { amenity: "parking" } },
      ]),
    },
  },
  "cameras/overpass": {
    reason: "malformed",
    payloads: {
      main: elements([
        {
          type: "node",
          id: 1,
          lat: 47.37,
          lon: 8.54,
          tags: { "contact:webcam": "https://cam.example/" },
        },
        { type: "node", id: 0, lat: 47.37, lon: 8.54, tags: { "contact:webcam": "https://x/" } },
      ]),
    },
  },
  // A latitude beyond 90° is a position, but no place.
  "fuel/overpass": {
    reason: "malformed",
    payloads: {
      main: elements([
        { type: "node", id: 1, lat: 47.37, lon: 8.54, tags: { amenity: "fuel" } },
        { type: "node", id: 2, lat: 95, lon: 8.54, tags: { amenity: "fuel" } },
      ]),
    },
  },
};

export const EXEMPT: SkipExemptions = {};
