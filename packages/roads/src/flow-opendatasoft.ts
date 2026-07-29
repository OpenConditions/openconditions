import type { LineString, Point } from "geojson";
import type { RoadEvent, RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import { ABSURD_SPEED_KPH, buildMeasuredSiteFlow, makeOrigin } from "./flow.js";
import type { FlowGeometry, FlowParseResult } from "./flow.js";

function num(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** First usable [lon,lat] LineString or Point from a GeoJSON geometry, else null. */
function toFlowGeometry(geom: unknown): FlowGeometry | null {
  if (!geom || typeof geom !== "object") return null;
  const g = geom as { type?: unknown; coordinates?: unknown };
  if (g.type === "Point" && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
    return {
      type: "Point",
      coordinates: [Number(g.coordinates[0]), Number(g.coordinates[1])],
    } as Point;
  }
  if (g.type === "LineString" && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
    return { type: "LineString", coordinates: g.coordinates as [number, number][] } as LineString;
  }
  // Some ODS segment feeds publish MultiLineString; use the first member line so
  // each observation carries a plain LineString (the model constraint).
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
  return null;
}

/**
 * Parse an OpenDataSoft `exports/geojson` traffic feed into RoadFlow
 * measurements, one per road segment. Driven entirely by the feed's `odsFlow`
 * field mapping so a single parser serves every ODS traffic dataset (Rennes'
 * per-segment average speed + free-flow, Bordeaux' / Valencia' categorical
 * status, …). Segments with no resolvable geometry, or with neither a speed nor
 * a resolvable level-of-service, are skipped. los, speed-ratio, free-flow
 * provenance and the derived congestion events are all produced by the shared
 * {@link buildMeasuredSiteFlow}; only the sourceFormat is restamped here.
 */
export function parseOpendatasoftFlow(
  input: string | Buffer,
  src: SourceDescriptor
): FlowParseResult {
  const mapping = src.odsFlow;
  if (!mapping) return { flows: [], events: [], failed: true };

  let payload: unknown;
  try {
    const str = Buffer.isBuffer(input) ? input.toString("utf8") : input;
    payload = typeof str === "string" ? JSON.parse(str) : str;
  } catch {
    return { flows: [], events: [], failed: true };
  }

  const features = (payload as { features?: unknown })?.features;
  // A hard failure (error page, wrong shape) has no features array at all; a
  // well-formed FeatureCollection with zero features is a legitimate empty cycle.
  if (!Array.isArray(features)) return { flows: [], events: [], failed: true };

  const flows: RoadFlow[] = [];
  const events: RoadEvent[] = [];
  const now = new Date().toISOString();
  const origin = makeOrigin(src);

  for (const feature of features) {
    try {
      if (!feature || typeof feature !== "object") continue;
      const props = ((feature as { properties?: unknown }).properties ?? {}) as Record<
        string,
        unknown
      >;
      const geom = toFlowGeometry((feature as { geometry?: unknown }).geometry);
      if (!geom) continue;

      const rawId = props[mapping.idField];
      const siteId = rawId != null && rawId !== "" ? String(rawId) : `ods-${flows.length + 1}`;

      const rawSpeed = mapping.speedField ? num(props[mapping.speedField]) : undefined;
      // Reject no-data sentinels (negatives) and sensor-glitch readings, keeping a
      // genuine 0 (real standstill).
      const speedKph =
        rawSpeed != null && rawSpeed >= 0 && rawSpeed < ABSURD_SPEED_KPH ? rawSpeed : undefined;
      const rawFreeFlow = mapping.freeFlowField ? num(props[mapping.freeFlowField]) : undefined;
      const freeFlowKph = rawFreeFlow != null && rawFreeFlow > 0 ? rawFreeFlow : undefined;

      let trafficStatus: string | undefined;
      if (mapping.statusField) {
        const raw = props[mapping.statusField];
        const rawStr = raw != null ? String(raw) : undefined;
        trafficStatus = rawStr != null ? (mapping.statusMap?.[rawStr] ?? rawStr) : undefined;
      }

      const measuredAt =
        (mapping.updatedField && typeof props[mapping.updatedField] === "string"
          ? (props[mapping.updatedField] as string)
          : undefined) ?? now;

      const built = buildMeasuredSiteFlow(
        {
          siteId,
          measuredAt,
          geom,
          ...(speedKph != null ? { speedKph } : {}),
          ...(trafficStatus != null ? { trafficStatus } : {}),
          ...(freeFlowKph != null ? { freeFlowKph } : {}),
        },
        src,
        origin,
        now
      );
      if (!built) continue;
      flows.push({ ...built.flow, sourceFormat: "opendatasoft" });
      if (built.event) events.push({ ...built.event, sourceFormat: "opendatasoft" });
    } catch (err) {
      console.warn("[opendatasoft-flow] skipped malformed feature:", err);
    }
  }

  return { flows, events };
}
