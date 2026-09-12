import type { Observation } from "@openconditions/core";
import { projectRoadRestrictionDetails, type RestrictionCarrier } from "@openconditions/roads";
import type { BBox, Feature, FeatureCollection } from "geojson";
import { type FeedInfo } from "./types.js";

/** A FeatureCollection plus the optional `feed_info` foreign member (RFC 7946 §6.1). */
export type ConditionsFeatureCollection = FeatureCollection & { feed_info?: FeedInfo };

export interface GeoJsonOptions {
  /** Include the verbatim `sourceRaw` passthrough in properties (off by default — it's large). */
  includeRaw?: boolean;
  /**
   * Evaluation instant for restriction display state. Injected so a frozen-time
   * test is deterministic; defaults to now for live responses. Historical
   * exports deliberately pass their own instant rather than inheriting "now",
   * so a stored evaluation is never read back as current.
   */
  at?: Date;
}

/**
 * GeoJSON `properties` is an arbitrary JSON object (RFC 7946 §3.2), so the whole
 * observation (minus geometry) is carried losslessly. `sourceRaw` is dropped
 * unless requested. Attribution is also flattened to convenience keys.
 */
function properties(o: Observation, includeRaw: boolean, at: Date): Record<string, unknown> {
  const att = o.origin.attribution;
  const { geometry: _geometry, ...rest } = o as Observation & { geometry: unknown };
  const bag = rest as Record<string, unknown>;
  if (!includeRaw) delete bag["sourceRaw"];
  const out: Record<string, unknown> = {
    ...bag,
    provider: att.provider,
    license: att.license,
    attributionUrl: att.url ?? null,
  };
  // Evaluate the restriction view here, at the publication edge, so the stored
  // source semantics stay free of computed state. Absence must stay absence: an
  // observation that says nothing about vehicles gets no marker at all.
  const carrier = o as Observation & RestrictionCarrier;
  if (
    Object.prototype.hasOwnProperty.call(carrier, "restrictionDetails") ||
    carrier.restrictionDetailsUnsupported === true
  ) {
    delete out["restrictionDetails"];
    delete out["restrictionDetailsUnsupported"];
    Object.assign(
      out,
      projectRoadRestrictionDetails(carrier.restrictionDetails, {
        at,
        sourceCheckedAt: o.sourceCheckedAt ?? null,
        freshnessWindowSec: o.freshnessWindowSec ?? null,
      })
    );
    // A producer-supplied unsupported marker survives its own projection.
    if (carrier.restrictionDetailsUnsupported === true) {
      out["restrictionDetailsUnsupported"] = true;
      delete out["restrictionDetails"];
    }
  }
  return out;
}

/** Bounding box [minLon, minLat, maxLon, maxLat] over all feature geometries (RFC 7946 §5). */
function computeBbox(features: Feature[]): BBox | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      found = true;
      minX = Math.min(minX, c[0]);
      minY = Math.min(minY, c[1]);
      maxX = Math.max(maxX, c[0]);
      maxY = Math.max(maxY, c[1]);
      return;
    }
    for (const x of c) visit(x);
  };
  for (const f of features) {
    const g = f.geometry as { coordinates?: unknown; geometries?: unknown[] } | null;
    if (!g) continue;
    if (Array.isArray(g.geometries)) {
      for (const sub of g.geometries) visit((sub as { coordinates?: unknown }).coordinates);
    } else {
      visit(g.coordinates);
    }
  }
  return found ? [minX, minY, maxX, maxY] : undefined;
}

/**
 * Projects observations to a GeoJSON FeatureCollection (RFC 7946) — the
 * universal, lossless baseline emitter. Every model field travels in `properties`
 * (sourceRaw gated by `opts.includeRaw`); feed-level attribution/license travel
 * as the `feed_info` foreign member (and should also be set as HTTP headers).
 */
export function observationsToGeoJSON(
  obs: Observation[],
  info: FeedInfo = {},
  opts: GeoJsonOptions = {}
): ConditionsFeatureCollection {
  const includeRaw = opts.includeRaw ?? false;
  const at = opts.at ?? new Date();
  const features = obs.map((o): Feature => ({
    type: "Feature",
    id: o.id,
    geometry: o.geometry,
    properties: properties(o, includeRaw, at),
  }));
  const fc: ConditionsFeatureCollection = { type: "FeatureCollection", features };
  const bbox = computeBbox(features);
  if (bbox) fc.bbox = bbox;
  if (Object.keys(info).length > 0) fc.feed_info = info;
  return fc;
}
