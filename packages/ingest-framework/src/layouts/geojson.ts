import type { Geometry } from "geojson";
import { reprojectorFor } from "../reproject.js";
import type { LayoutBlock } from "./block.js";
import { getPath, type LayoutRow, placeable, pointFromFields, vertexMean } from "./row.js";

/** The CRS name on a geometry or FeatureCollection `crs` member, if any. */
export function crsName(crs: unknown): string | undefined {
  const name = (crs as { properties?: { name?: unknown } })?.properties?.name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Recursively remap every coordinate pair of a geometry through `fn`, dropping
 * any now-stale `crs` member (coords become WGS84).
 */
export function remapCoords(
  geometry: Geometry,
  fn: (p: [number, number]) => [number, number],
): Geometry {
  const { crs: _crs, ...geom } = geometry as Geometry & { crs?: unknown };
  if (geom.type === "GeometryCollection") {
    return { ...geom, geometries: geom.geometries.map((g) => remapCoords(g, fn)) };
  }
  const walk = (c: unknown): unknown =>
    Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number"
      ? fn([c[0], c[1]])
      : Array.isArray(c)
        ? c.map(walk)
        : c;
  return {
    ...geom,
    coordinates: walk((geom as { coordinates: unknown }).coordinates),
  } as Geometry;
}

/** Whether a value is a GeoJSON geometry that carries shape. */
export function hasShape(value: unknown): value is Geometry {
  if (!value || typeof value !== "object") return false;
  const g = value as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  return (
    typeof g.type === "string" &&
    (g.coordinates !== undefined || (g.type === "GeometryCollection" && g.geometries !== undefined))
  );
}

/**
 * A geometry in WGS84. A CRS declared on the geometry itself (OGC API) wins
 * over the one on the collection (ArcGIS, WFS), which wins over `fallbackCrs`;
 * a WGS84 or unknown CRS leaves the coordinates as published.
 */
export function reprojectGeometry(
  geometry: Geometry,
  collectionCrs?: string,
  fallbackCrs?: string,
): Geometry {
  const reproject = reprojectorFor(
    crsName((geometry as { crs?: unknown }).crs) ?? collectionCrs ?? fallbackCrs,
  );
  return reproject ? remapCoords(geometry, reproject) : geometry;
}

/** The FeatureCollection members of a GeoJSON text, or undefined when it is not JSON. */
export function readFeatureCollection(
  text: string,
  records?: string,
): { features: unknown[]; crs: string | undefined } | undefined {
  let doc: { features?: unknown; crs?: unknown };
  try {
    doc = JSON.parse(text) as { features?: unknown; crs?: unknown };
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object") return undefined;
  const list = records ? getPath(doc, records) : doc.features;
  return {
    features: Array.isArray(list) ? list : [],
    crs: crsName(doc.crs),
  };
}

function vertices(geometry: Geometry): [number, number][] {
  const out: [number, number][] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") out.push([c[0], c[1]]);
    else c.forEach(walk);
  };
  if (geometry.type !== "GeometryCollection") walk(geometry.coordinates);
  return out;
}

/**
 * A single point for a geometry: a Point itself, the vertex mean of a line or
 * polygon, the first Point of a collection.
 */
export function geometryPoint(geometry: Geometry): [number, number] | undefined {
  if (geometry.type === "GeometryCollection") {
    const first = geometry.geometries.find((g) => g.type === "Point");
    return first ? geometryPoint(first) : undefined;
  }
  const mean = vertexMean(vertices(geometry));
  return mean && placeable(mean[0], mean[1]);
}

/** The rows of a FeatureCollection: `properties` as fields, a point from the block or the geometry. */
export function decodeGeoJson(text: string, block: LayoutBlock): LayoutRow[] {
  const collection = readFeatureCollection(text, block.records);
  if (!collection) return [];
  const rows: LayoutRow[] = [];
  for (const feature of collection.features) {
    const f = (feature ?? {}) as { geometry?: unknown; properties?: unknown };
    const fields =
      f.properties && typeof f.properties === "object"
        ? (f.properties as Record<string, unknown>)
        : {};
    let point = pointFromFields(fields, block);
    if (!point && hasShape(f.geometry)) {
      point = geometryPoint(reprojectGeometry(f.geometry, collection.crs, block.crs));
    }
    rows.push(point ? { point, fields } : { fields });
  }
  return rows;
}
