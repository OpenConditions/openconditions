import type { Contributor } from "@openconditions/core";
import type { Feature, Geometry } from "geojson";
import { rfc7946Geometry } from "./rfc7946.js";

/**
 * One row of `road_segment LEFT JOIN segment_speed` — a directed road segment
 * plus whatever fused speed the tiered-fusion pipeline (`segment-speed.ts`)
 * has produced for it, if any. Mirrors the reader query in `publish-routes.ts`
 * and the attribute set on the `conditions.segment_flow` MVT function (C4).
 *
 * Speed fields are `?: T | null`: a segment with no matching `segment_speed`
 * row comes back from the LEFT JOIN with SQL `NULL`, which the postgres driver
 * surfaces as JS `null` (not `undefined`), so the emitter must treat both the
 * same when deciding whether to omit a property.
 */
export interface SegmentSpeedRow {
  segmentId: string;
  dir: "f" | "b";
  highway: string;
  ref?: string | null;
  geojson: string;
  speedRatio?: number | null;
  los?: string | null;
  confidence?: string | null;
  currentKph?: number | null;
  freeFlowKph?: number | null;
  /** ISO timestamp; the caller is responsible for coercing the driver's raw
   * `Date` (postgres-js returns `timestamptz` as `Date`) before this row is
   * built — see the `/segments.geojson` route. */
  observedAt?: string | null;
  fieldLineageComplete?: Record<string, boolean> | null;
  fieldSources?: Record<string, string[]> | null;
  fieldContributors?: Record<string, Contributor[]> | null;
}

/**
 * Projects segment-speed rows into a GeoJSON FeatureCollection for the
 * colored-segment overlay (`GET /segments.geojson`) and the OpenMapX
 * `getFlow` provider source. A base segment with no fused speed yet (no
 * `segment_speed` row) arrives with every speed-related field null/undefined;
 * those are dropped from `properties` entirely (never sent as `null`) so the
 * consumer's own "no speed row -> los: unknown, confidence: typical" mapping
 * (C4) stays the single place that invents a default, rather than this
 * emitter guessing one. The `!= null` guard omits both `null` (real LEFT-JOIN
 * miss from the driver) and `undefined` (an in-memory row that never set it).
 * A segment drawn across the antimeridian is cut there into a
 * MultiLineString (`rfc7946Geometry`).
 */
export function segmentsToGeoJSON(rows: SegmentSpeedRow[]): {
  type: "FeatureCollection";
  features: unknown[];
} {
  const features: Feature[] = rows.map((row) => {
    const properties: Record<string, unknown> = {
      segment_id: row.segmentId,
      dir: row.dir,
      highway: row.highway,
    };
    if (row.ref != null) properties["ref"] = row.ref;
    if (row.speedRatio != null) properties["speed_ratio"] = row.speedRatio;
    if (row.los != null) properties["los"] = row.los;
    if (row.confidence != null) properties["confidence"] = row.confidence;
    if (row.currentKph != null) properties["current_kph"] = row.currentKph;
    if (row.freeFlowKph != null) properties["free_flow_kph"] = row.freeFlowKph;
    if (row.observedAt != null) properties["observed_at"] = row.observedAt;
    if (row.fieldSources != null || row.fieldContributors != null)
      properties["lineage_version"] = 1;
    if (row.fieldLineageComplete != null)
      properties["field_lineage_complete"] = row.fieldLineageComplete;
    if (row.fieldSources != null) properties["field_sources"] = row.fieldSources;
    if (row.fieldContributors != null) properties["field_contributors"] = row.fieldContributors;
    return {
      type: "Feature",
      geometry: rfc7946Geometry(JSON.parse(row.geojson) as Geometry),
      properties,
    };
  });
  return { type: "FeatureCollection", features };
}
