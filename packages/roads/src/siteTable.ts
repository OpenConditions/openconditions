/**
 * Parser for a DATEX II MeasurementSiteTablePublication — the static site
 * registry that pairs with a MeasuredDataPublication. Many real feeds (notably
 * NDW) ship measurements in one document keyed only by a site id, and the
 * geometry for those sites in a separate, slowly-changing table document. This
 * parser turns that table into an id→Geometry map the measured-data parser can
 * join against.
 *
 * NDW sites are point loop-detectors carrying a `measurementSiteLocation`
 * with either an `xsi:type="Point"` (a single `locationForDisplay` lat/lon) or
 * an `xsi:type="ItineraryByIndexedLocations"` wrapping a `Linear` location
 * (start/end `pointCoordinates`). Records with no resolvable location are
 * skipped.
 */
import type { LineString, Point } from "geojson";
import { resolveLineStringFromLocRef } from "./flow.js";

/** Geometry shapes a measurement site can resolve to. */
export type SiteGeometry = Point | LineString;
import {
  getXmlChild,
  isXmlObject,
  parseXmlDocument,
  stripXmlNamespace,
  xmlNodeToArray,
  xmlText,
} from "./xml.js";

function parseLatLonNode(node: unknown): Point | null {
  if (!isXmlObject(node)) return null;
  const latRaw = xmlText(node["latitude"]);
  const lonRaw = xmlText(node["longitude"]);
  const lat = latRaw != null ? Number(latRaw) : NaN;
  const lon = lonRaw != null ? Number(lonRaw) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { type: "Point", coordinates: [lon, lat] };
}

/** Find the first `pointCoordinates` lat/lon under a named wrapper element. */
function findEndpoint(node: unknown, wrapper: string): Point | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findEndpoint(item, wrapper);
      if (found) return found;
    }
    return null;
  }
  if (!isXmlObject(node)) return null;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (stripXmlNamespace(key) === wrapper) {
      for (const child of xmlNodeToArray(value)) {
        const point = parseLatLonNode(getXmlChild(child, "pointCoordinates"));
        if (point) return point;
      }
    }
    const nested = findEndpoint(value, wrapper);
    if (nested) return nested;
  }
  return null;
}

/**
 * Resolve a start/end `pointCoordinates` pair (NDW's linearByCoordinatesExtension
 * shape) into a LineString. Returns null unless both endpoints parse.
 */
function resolveLineFromCoordinatePair(node: unknown): LineString | null {
  if (!isXmlObject(node)) return null;
  const start = findEndpoint(node, "linearCoordinatesStartPoint");
  const end = findEndpoint(node, "linearCoordinatesEndPoint");
  if (!start || !end) return null;
  return { type: "LineString", coordinates: [start.coordinates, end.coordinates] };
}

/**
 * Find the first `locationForDisplay` lat/lon anywhere under a node.
 */
function findDisplayPoint(node: unknown): Point | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findDisplayPoint(item);
      if (found) return found;
    }
    return null;
  }
  if (!isXmlObject(node)) return null;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (stripXmlNamespace(key) === "locationForDisplay") {
      for (const child of xmlNodeToArray(value)) {
        const point = parseLatLonNode(child);
        if (point) return point;
      }
    }
    const nested = findDisplayPoint(value);
    if (nested) return nested;
  }
  return null;
}

/**
 * Resolve the geometry of a single measurementSiteLocation, preferring a
 * coordinate-bearing LineString when one is present and falling back to a
 * display Point. Returns null when nothing resolves.
 */
function resolveSiteGeometry(location: unknown): SiteGeometry | null {
  if (!isXmlObject(location)) return null;

  const posLine = resolveLineStringFromLocRef(location);
  if (posLine) return posLine;

  const coordLine = resolveLineFromCoordinatePair(location);
  if (coordLine) return coordLine;

  return findDisplayPoint(location);
}

/**
 * Parse a DATEX II MeasurementSiteTablePublication into a map of
 * `measurementSiteRecord id` → resolved geometry. The id is the join key used by
 * a MeasuredDataPublication's `measurementSiteReference id`.
 */
export function parseDatexSiteTable(input: string | Buffer): Map<string, SiteGeometry> {
  const map = new Map<string, SiteGeometry>();

  let doc: ReturnType<typeof parseXmlDocument>;
  try {
    doc = parseXmlDocument(input, {
      removeNSPrefix: true,
      ignoreAttributes: false,
      isArray: (n) => n === "measurementSiteRecord" || n === "measurementSiteTable",
    });
  } catch (err) {
    console.warn("[datex-site-table] failed to parse XML:", err);
    return map;
  }

  const records: unknown[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (!isXmlObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@_")) continue;
      if (stripXmlNamespace(key) === "measurementSiteRecord") {
        for (const rec of xmlNodeToArray(value)) records.push(rec);
      } else {
        collect(value);
      }
    }
  };
  collect(doc);

  for (const record of records) {
    if (!isXmlObject(record)) continue;
    const siteId = record["@_id"] as string | undefined;
    if (!siteId) continue;
    const location = getXmlChild(record, "measurementSiteLocation");
    if (!location) continue;
    const geom = resolveSiteGeometry(location);
    if (geom) map.set(siteId, geom);
  }

  return map;
}
