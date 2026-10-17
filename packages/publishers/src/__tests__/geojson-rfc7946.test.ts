import {
  assertCovered,
  type JsonValidator,
  jsonSchemaValidator,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { GEOJSON } from "@openconditions/conformance/standards/geojson";
import { Geometry as ModelGeometry } from "@openconditions/model";
import type { Feature, Geometry, Position } from "geojson";
import { beforeAll, describe, expect, it } from "vitest";
import { featuresToGeoJSON, featuresToJsonLd } from "../feature-geojson.js";
import { rfc7946Geometry } from "../rfc7946.js";
import { segmentConditionsToJson } from "../segment-conditions.js";
import { segmentsToGeoJSON } from "../segments.js";
import { situationsToGeoJSON, situationsToJsonLd } from "../situation-geojson.js";
import { rfc7946Violations, signedArea } from "./rfc7946-checks.js";
import { segmentRow } from "./segment-rows.js";

type Rec = Record<string, unknown>;

const AT = new Date("2026-09-06T10:00:00Z");
const INFO = {
  attribution: "OpenConditions",
  license: "ODbL-1.0",
  url: "https://openconditions.org",
  timestamp: "2026-09-06T10:00:00Z",
};

/**
 * A CAP `circle` drawn the way the CAP parser draws one: vertices by bearing
 * from north through east, which runs clockwise on a longitude/latitude plane.
 */
function capCircleRing(lon: number, lat: number, km: number, n = 16): Position[] {
  const ring: Position[] = [];
  for (let i = 0; i < n; i++) {
    const bearing = (2 * Math.PI * i) / n;
    const dLat = (km / 111.2) * Math.cos(bearing);
    const dLon = ((km / 111.2) * Math.sin(bearing)) / Math.cos((lat * Math.PI) / 180);
    ring.push([Math.round((lon + dLon) * 1e6) / 1e6, Math.round((lat + dLat) * 1e6) / 1e6]);
  }
  return [...ring, ring[0]!];
}

function situation(id: string, kind: string, geometry: Geometry | null, over: Rec = {}): Rec {
  return {
    id: `oc:situation:test:${id}`,
    revision: 1,
    class: "situation",
    kind,
    type: kind === "roadworks" ? "works" : kind,
    temporality: "live",
    certainty: "observed",
    severity: { label: "major", source: "derived" },
    headline: [{ lang: "en", text: id }],
    validity: { status: "active", start: "2026-09-06T08:00:00Z", end: "2026-09-07T08:00:00Z" },
    effects: [],
    location: geometry ? { geometry, description: id } : { description: id },
    provenance: { sourceUpdatedAt: "2026-09-06T09:00:00Z" },
    ...over,
  };
}

/** Situations in every geometry the model holds, as the feeds draw them. */
const SITUATIONS: Rec[] = [
  situation("a46-roadworks", "roadworks", {
    type: "LineString",
    coordinates: [
      [6.805, 51.2],
      [6.818, 51.2],
    ],
  }),
  // A National Weather Service polygon, clockwise as the CAP feed lists it,
  // with an island hole drawn counterclockwise.
  situation("nws-flood", "hazard", {
    type: "Polygon",
    coordinates: [
      [
        [-90.1, 30.0],
        [-90.1, 30.4],
        [-89.6, 30.4],
        [-89.6, 30.0],
        [-90.1, 30.0],
      ],
      [
        [-89.9, 30.1],
        [-89.8, 30.1],
        [-89.8, 30.2],
        [-89.9, 30.2],
        [-89.9, 30.1],
      ],
    ],
  }),
  situation("cap-circle", "hazard", {
    type: "Polygon",
    coordinates: [capCircleRing(13.4, 52.5, 20)],
  }),
  // An Aleutian zone already split at the antimeridian, as the CAP parser
  // splits one, but each part clockwise.
  situation("aleutian-wind", "hazard", {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [178.5, 51.5],
          [178.5, 52.2],
          [180, 52.2],
          [180, 51.5],
          [178.5, 51.5],
        ],
      ],
      [
        [
          [-180, 51.5],
          [-180, 52.2],
          [-178.2, 52.2],
          [-178.2, 51.5],
          [-180, 51.5],
        ],
      ],
    ],
  }),
  // A road closure on Taveuni, which the antimeridian runs across.
  situation("taveuni-closure", "closure", {
    type: "LineString",
    coordinates: [
      [179.97, -16.82],
      [179.99, -16.8],
      [-179.98, -16.78],
      [-179.96, -16.76],
    ],
  }),
  situation("a3-both-carriageways", "closure", {
    type: "MultiLineString",
    coordinates: [
      [
        [8.5, 50.0],
        [8.52, 50.01],
      ],
      [
        [8.52, 50.011],
        [8.5, 50.001],
      ],
    ],
  }),
  situation("avalanche-cameras", "hazard", {
    type: "MultiPoint",
    coordinates: [
      [11.39, 47.26, 1850],
      [11.41, 47.27, 1920],
    ],
  }),
  situation("wildfire", "hazard", {
    type: "GeometryCollection",
    geometries: [
      { type: "Point", coordinates: [-120.5, 38.2] },
      {
        type: "Polygon",
        coordinates: [
          [
            [-120.6, 38.1],
            [-120.6, 38.3],
            [-120.4, 38.3],
            [-120.4, 38.1],
            [-120.6, 38.1],
          ],
        ],
      },
    ],
  }),
  // A Chatham Islands hazard, east of the antimeridian and not crossing it.
  situation("chatham-swell", "hazard", {
    type: "Point",
    coordinates: [-176.56, -43.95],
  }),
  situation("description-only", "closure", null),
];

const FEATURES: Rec[] = [
  {
    id: "oc:feature:nl-ndw-sites:RWS01_MONIBAS_0021hrl0403ra",
    class: "feature",
    kind: "measurement_site",
    type: "inductive_loop",
    name: "A2 km 40.3",
    components: [
      { id: "oc:component:nl-ndw-sites:RWS01_MONIBAS_0021hrl0403ra:1", kind: "sensor_channel" },
    ],
    location: { geometry: { type: "Point", coordinates: [4.9, 52.3] } },
  },
  {
    id: "oc:feature:osm-parking:way-1",
    class: "feature",
    kind: "parking",
    type: "surface",
    name: "P+R Nord",
    // Clockwise, as an OpenStreetMap way often runs.
    location: {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [9.18, 48.8],
            [9.18, 48.802],
            [9.183, 48.802],
            [9.183, 48.8],
            [9.18, 48.8],
          ],
        ],
      },
    },
  },
  {
    id: "oc:feature:fj-roads:taveuni-ferry-landing",
    class: "feature",
    kind: "ferry_terminal",
    type: "terminal",
    name: "Waiyevo",
    // A terminal area spanning the antimeridian.
    location: {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [179.998, -16.79],
            [-179.998, -16.79],
            [-179.998, -16.788],
            [179.998, -16.788],
            [179.998, -16.79],
          ],
        ],
      },
    },
  },
  { id: "oc:feature:test:unlocated", class: "feature", kind: "road", type: "road" },
];

const SEGMENTS = [
  {
    segmentId: "1:f",
    dir: "f" as const,
    highway: "motorway",
    geojson: '{"type":"LineString","coordinates":[[5,52],[5.1,52.1]]}',
    speedRatio: 0.5,
    los: "heavy",
  },
  {
    segmentId: "2:f",
    dir: "f" as const,
    highway: "secondary",
    geojson: '{"type":"LineString","coordinates":[[179.99,-16.8],[-179.98,-16.78]]}',
  },
];

/** Every geometry in a document, GeometryCollections' members included. */
function geometries(doc: { features: Feature[] }): Geometry[] {
  const out: Geometry[] = [];
  const add = (g: Geometry | null) => {
    if (!g) return;
    out.push(g);
    if (g.type === "GeometryCollection") g.geometries.forEach(add);
  };
  for (const f of doc.features) add(f.geometry);
  return out;
}

const documents = () => ({
  "situations GeoJSON": situationsToGeoJSON(SITUATIONS, INFO, { at: AT, next: null }),
  "situations GeoJSON-LD": situationsToJsonLd(SITUATIONS, INFO, { at: AT, next: "cursor" }),
  "features GeoJSON": featuresToGeoJSON(FEATURES, INFO),
  "features GeoJSON-LD": featuresToJsonLd(FEATURES, INFO),
  "segments GeoJSON": segmentsToGeoJSON(SEGMENTS) as {
    type: "FeatureCollection";
    features: Feature[];
  },
});

describe("GeoJSON emitters against the GeoJSON JSON Schemas", () => {
  let validators: Map<string, JsonValidator> | undefined;
  let standardTypes: string[] = [];
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(GEOJSON);
    if ("unavailable" in pinned) {
      unavailable = pinned.unavailable;
      return;
    }
    const schemas = new Map(
      pinned.files.map((f) => [f.fileName.replace(/\.json$/, ""), JSON.parse(f.contents) as Rec]),
    );
    validators = new Map([...schemas].map(([name, schema]) => [name, jsonSchemaValidator(schema)]));
    const oneOf = schemas.get("Geometry")!["oneOf"] as Array<{
      properties: { type: { enum: string[] } };
    }>;
    standardTypes = [...oneOf.map((s) => s.properties.type.enum[0]!), "GeometryCollection"];
  }, 120_000);

  it("the fixtures hold every geometry type, in shapes the model accepts", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const held = new Set<string>();
    for (const record of [...SITUATIONS, ...FEATURES]) {
      const g = (record["location"] as Rec | undefined)?.["geometry"];
      if (g === undefined) continue;
      expect(ModelGeometry.safeParse(g).success, String(record["id"])).toBe(true);
      held.add((g as Geometry).type);
      if ((g as Geometry).type === "GeometryCollection") {
        for (const m of (g as { geometries: Geometry[] }).geometries) held.add(m.type);
      }
    }
    assertCovered("GeoJSON geometry types", standardTypes, { handled: held });
  });

  it.for(Object.keys(documents()))("%s validates as a FeatureCollection", (name, { skip }) => {
    if (unavailable) skip(unavailable);
    const doc = documents()[name as keyof ReturnType<typeof documents>];
    const json = JSON.parse(JSON.stringify(doc)) as { features: Feature[] };
    expect(validators!.get("FeatureCollection")!(json)).toEqual([]);
    for (const f of json.features) expect(validators!.get("Feature")!(f)).toEqual([]);
    for (const g of geometries(json)) {
      expect(validators!.get(g.type)!(g), g.type).toEqual([]);
      if (g.type !== "GeometryCollection") expect(validators!.get("Geometry")!(g)).toEqual([]);
      expect(ModelGeometry.safeParse(g).success, JSON.stringify(g)).toBe(true);
    }
  });

  it("segment-condition spans carry valid LineStrings", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const out = segmentConditionsToJson([segmentRow()], AT, { resolverVersion: "2.0.0" });
    const spans = out.conditions.flatMap((c) => c.segments);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(validators!.get("LineString")!(span.geometry)).toEqual([]);
      expect(
        rfc7946Violations({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: span.geometry, properties: {} }],
        }),
      ).toEqual([]);
    }
  });
});

describe("GeoJSON emitters against RFC 7946", () => {
  it.for(Object.keys(documents()))("%s keeps the rules its schema cannot express", (name) => {
    const doc = documents()[name as keyof ReturnType<typeof documents>];
    expect(rfc7946Violations(JSON.parse(JSON.stringify(doc)))).toEqual([]);
  });

  it("identifies each feature by a string, and keeps @context and @type as foreign members", () => {
    const ld = situationsToJsonLd(SITUATIONS, INFO, { at: AT });
    expect(ld["@context"]).toBeDefined();
    for (const f of ld.features as Array<Feature & { "@type"?: unknown }>) {
      expect(typeof f.id).toBe("string");
      expect(f["@type"]).toBe("schema:SpecialAnnouncement");
    }
    const unlocated = featuresToGeoJSON(FEATURES).features.at(-1)!;
    expect(unlocated.geometry).toBeNull();
  });

  it("rewinds a clockwise exterior counterclockwise and a counterclockwise hole clockwise", () => {
    const [flood] = situationsToGeoJSON([SITUATIONS[1]!], {}, { at: AT }).features;
    const [exterior, hole] = (flood!.geometry as { coordinates: Position[][] }).coordinates;
    expect(signedArea(exterior!)).toBeGreaterThan(0);
    expect(signedArea(hole!)).toBeLessThan(0);
    expect(new Set(exterior!.map(String))).toEqual(
      new Set(
        (
          SITUATIONS[1]!["location"] as { geometry: { coordinates: Position[][] } }
        ).geometry.coordinates[0]!.map(String),
      ),
    );
  });

  it("leaves the records it wraps untouched", () => {
    const before = structuredClone(SITUATIONS);
    situationsToGeoJSON(SITUATIONS, {}, { at: AT });
    situationsToJsonLd(SITUATIONS, {}, { at: AT });
    expect(SITUATIONS).toEqual(before);
  });

  it("passes a geometry already in RFC 7946 form through as the same object", () => {
    const line = (SITUATIONS[0]!["location"] as { geometry: Geometry }).geometry;
    expect(rfc7946Geometry(line)).toBe(line);
    const [feature] = situationsToGeoJSON([SITUATIONS[0]!], {}, { at: AT }).features;
    expect(feature!.geometry).toBe(line);
  });
});

describe("rfc7946Geometry at the antimeridian", () => {
  it("cuts the RFC's line from 170°E to 170°W into its MultiLineString", () => {
    expect(
      rfc7946Geometry({
        type: "LineString",
        coordinates: [
          [170, 45],
          [-170, 45],
        ],
      }),
    ).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [170, 45],
          [180, 45],
        ],
        [
          [-180, 45],
          [-170, 45],
        ],
      ],
    });
  });

  it("cuts the RFC's rectangle from 170°E to 170°W into its MultiPolygon", () => {
    expect(
      rfc7946Geometry({
        type: "Polygon",
        coordinates: [
          [
            [170, 40],
            [-170, 40],
            [-170, 50],
            [170, 50],
            [170, 40],
          ],
        ],
      }),
    ).toEqual({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [170, 40],
            [180, 40],
            [180, 50],
            [170, 50],
            [170, 40],
          ],
        ],
        [
          [
            [-180, 40],
            [-170, 40],
            [-170, 50],
            [-180, 50],
            [-180, 40],
          ],
        ],
      ],
    });
  });

  it("passes the RFC's own cut MultiPolygon through unchanged", () => {
    const cut: Geometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [180, 40],
            [180, 50],
            [170, 50],
            [170, 40],
            [180, 40],
          ],
        ],
        [
          [
            [-170, 40],
            [-170, 50],
            [-180, 50],
            [-180, 40],
            [-170, 40],
          ],
        ],
      ],
    };
    expect(rfc7946Geometry(cut)).toBe(cut);
  });

  it("cuts a polygon with a hole across the antimeridian, keeping each hole with its part", () => {
    const out = rfc7946Geometry({
      type: "Polygon",
      coordinates: [
        [
          [175, -20],
          [-175, -20],
          [-175, -10],
          [175, -10],
          [175, -20],
        ],
        [
          [-178, -16],
          [-177, -16],
          [-177, -15],
          [-178, -15],
          [-178, -16],
        ],
      ],
    }) as { type: string; coordinates: Position[][][] };
    expect(out.type).toBe("MultiPolygon");
    const [west, east] = out.coordinates;
    expect(west).toHaveLength(1);
    expect(east).toHaveLength(2);
    expect(signedArea(east![1]!)).toBeLessThan(0);
    expect(east![1]).toEqual([
      [-178, -16],
      [-178, -15],
      [-177, -15],
      [-177, -16],
      [-178, -16],
    ]);
  });

  it("interpolates the elevation where a 3D line is cut", () => {
    expect(
      rfc7946Geometry({
        type: "LineString",
        coordinates: [
          [179, 0, 100],
          [-179, 0, 300],
        ],
      }),
    ).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [179, 0, 100],
          [180, 0, 200],
        ],
        [
          [-180, 0, 200],
          [-179, 0, 300],
        ],
      ],
    });
  });

  it("reads a vertex on the antimeridian as on either side", () => {
    expect(
      rfc7946Geometry({
        type: "LineString",
        coordinates: [
          [178, 1],
          [180, 1],
          [-178, 1],
        ],
      }),
    ).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [178, 1],
          [180, 1],
        ],
        [
          [-180, 1],
          [-178, 1],
        ],
      ],
    });
  });

  it("does not cut a line running along the antimeridian, nor a world-wide box", () => {
    const along: Geometry = {
      type: "LineString",
      coordinates: [
        [180, 60],
        [-180, 65],
      ],
    };
    const world: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [-180, -90],
          [180, -90],
          [180, 90],
          [-180, 90],
          [-180, -90],
        ],
      ],
    };
    expect(rfc7946Geometry(along)).toBe(along);
    expect(rfc7946Geometry(world)).toBe(world);
  });

  it("leaves a ring running once round a pole as it is", () => {
    const cap: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 80],
          [120, 80],
          [-120, 80],
          [0, 80],
        ],
      ],
    };
    expect(rfc7946Geometry(cap)).toBe(cap);
  });
});
