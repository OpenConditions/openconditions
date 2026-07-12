import {
  centroid,
  haversineMeters,
  isoUtcEpochMs,
  type GeoJsonGeometry,
} from "@openconditions/core";

/**
 * Kinematic plausibility of a reporter's report-to-report transition — a pure
 * post-hoc ANOMALY signal, never an admission gate. A truthful fast mover must
 * not be censored, so the landing path only FLAGS an implausible transition
 * (observations.flagged_at); it never blocks or rejects the report.
 */

/** The geometry + instant of one landed report by a key (server clock basis). */
export interface PriorReport {
  geometry: GeoJsonGeometry;
  /** ISO 8601 instant the report was observed (server occurred_at). */
  reportedAt: string;
}

/**
 * Great-circle speed in km/h implied by moving between two reports' geometry
 * centroids in the time between them. Returns null when the transition carries
 * no speed information: Δt <= 0 (simultaneous or out-of-order instants,
 * including unparseable ones) or zero distance (the same point).
 */
export function impliedSpeedKmh(prev: PriorReport, next: PriorReport): number | null {
  const deltaMs = isoUtcEpochMs(next.reportedAt) - isoUtcEpochMs(prev.reportedAt);
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return null;
  }
  const meters = haversineMeters(centroid(prev.geometry), centroid(next.geometry));
  if (meters === 0) {
    return null;
  }
  return meters / 1000 / (deltaMs / 3_600_000);
}

/**
 * True unless the implied speed exceeds `maxKmh`. The 400 km/h default is
 * deliberately generous — it flags teleport/GPS-spoof patterns, not fast
 * driving (or a passenger on a high-speed train). A transition with no speed
 * information (see {@link impliedSpeedKmh}) is plausible by definition.
 */
export function isKinematicallyPlausible(
  prev: PriorReport,
  next: PriorReport,
  maxKmh = 400
): boolean {
  const speed = impliedSpeedKmh(prev, next);
  return speed === null || speed <= maxKmh;
}
