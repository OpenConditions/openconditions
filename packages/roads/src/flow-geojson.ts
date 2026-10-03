import type { LineString, Point } from "geojson";
import type { FlowContext, FlowSites } from "./flow-output.js";
import {
  type FlowParse,
  type FlowReading,
  measuredReading,
  plausibleSpeed,
} from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

type FlowGeometry = Point | LineString;

function num(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** First usable [lon,lat] LineString or Point from a GeoJSON geometry, else null. */
function toFlowGeometry(geom: unknown): FlowGeometry | null {
  if (!geom || typeof geom !== "object") return null;
  const g = geom as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (g.type === "Point" && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
    return {
      type: "Point",
      coordinates: [Number(g.coordinates[0]), Number(g.coordinates[1])],
    } as Point;
  }
  if (g.type === "LineString" && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
    return { type: "LineString", coordinates: g.coordinates as [number, number][] } as LineString;
  }
  // Some segment feeds publish MultiLineString; use the first member line so each
  // observation carries a plain LineString (the model constraint).
  if (
    g.type === "MultiLineString" &&
    Array.isArray(g.coordinates) &&
    Array.isArray(g.coordinates[0]) &&
    (g.coordinates[0] as unknown[]).length >= 2
  ) {
    return {
      type: "LineString",
      coordinates: g.coordinates[0] as [number, number][],
    } as LineString;
  }
  // A GeometryCollection (some government GeoJSON, e.g. an older Victoria layout)
  // wraps member geometries; recurse into the first usable one.
  if (g.type === "GeometryCollection" && Array.isArray(g.geometries)) {
    for (const member of g.geometries) {
      const resolved = toFlowGeometry(member);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Parse a plain GeoJSON `FeatureCollection` traffic feed, one reading per
 * road segment. Driven entirely by the feed's `flowMap` field mapping, so a
 * single parser serves every feed that publishes features with inline
 * geometry plus flat `properties` carrying a per-segment average speed and/or
 * categorical traffic status — OpenDataSoft exports (Rennes, Bordeaux) and
 * Azure-APIM GeoJSON (Victoria Freeway Travel Time) alike. Segments with no
 * resolvable geometry, or with neither a speed nor a resolvable level of
 * service, are skipped.
 */
export function parseGeojsonFlow(
  input: string | Buffer,
  src: SourceDescriptor,
  _sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  const mapping = src.flowMap;
  if (!mapping) return { readings: [], failed: true };

  let payload: unknown;
  try {
    const str = Buffer.isBuffer(input) ? input.toString("utf8") : input;
    payload = typeof str === "string" ? JSON.parse(str) : str;
  } catch {
    return { readings: [], failed: true };
  }

  const features = (payload as { features?: unknown })?.features;
  // A hard failure (error page, wrong shape) has no features array at all; a
  // well-formed FeatureCollection with zero features is a legitimate empty cycle.
  if (!Array.isArray(features)) return { readings: [], failed: true };

  const readings: FlowReading[] = [];
  for (const feature of features) {
    try {
      if (!feature || typeof feature !== "object") continue;
      const props = ((feature as { properties?: unknown }).properties ?? {}) as Record<
        string,
        unknown
      >;
      const geometry = toFlowGeometry((feature as { geometry?: unknown }).geometry);
      if (!geometry) continue;

      const rawId = props[mapping.idField];
      const siteId = rawId != null && rawId !== "" ? String(rawId) : `feat-${readings.length + 1}`;

      const rawSpeed = mapping.speedField ? num(props[mapping.speedField]) : undefined;
      const speedKph = plausibleSpeed(rawSpeed) ? rawSpeed : undefined;
      const rawFreeFlow = mapping.freeFlowField ? num(props[mapping.freeFlowField]) : undefined;
      const freeFlowKph = rawFreeFlow != null && rawFreeFlow > 0 ? rawFreeFlow : undefined;

      let trafficStatus: string | undefined;
      if (mapping.statusField) {
        const raw = props[mapping.statusField];
        const rawStr = raw != null ? String(raw) : undefined;
        trafficStatus = rawStr != null ? (mapping.statusMap?.[rawStr] ?? rawStr) : undefined;
      }
      const at =
        mapping.updatedField && typeof props[mapping.updatedField] === "string"
          ? (props[mapping.updatedField] as string)
          : undefined;

      const reading = measuredReading({
        site: siteId,
        geometry,
        ...(at !== undefined ? { at } : {}),
        ...(speedKph != null ? { speedKph } : {}),
        ...(trafficStatus != null ? { trafficStatus } : {}),
        ...(freeFlowKph != null ? { freeFlowKph } : {}),
      });
      if (reading) readings.push(reading);
    } catch (err) {
      console.warn("[geojson-flow] skipped malformed feature:", err);
    }
  }

  return { readings };
}
