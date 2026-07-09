/**
 * Directed traffic-segment identity, level-of-detail, and per-way direction
 * helpers (Shared Contract C1). Pure, DB-free.
 */

export type Dir = "f" | "b";

/** `segment_id` = `${way_id}:${dir}` (C1). */
export function segmentId(wayId: number, dir: Dir): string {
  return `${wayId}:${dir}`;
}

const MIN_ZOOM: Record<string, number> = {
  motorway: 5,
  trunk: 7,
  primary: 9,
  motorway_link: 10,
  trunk_link: 10,
  primary_link: 10,
};

const DEFAULT_MIN_ZOOM = 11;

/** Min display zoom by OSM `highway` class, matching the segment-build SQL CASE. */
export function minZoomForHighway(highway: string): number {
  return MIN_ZOOM[highway] ?? DEFAULT_MIN_ZOOM;
}

/**
 * Which directed segments a way yields: a bidirectional way produces both
 * `f` and `b`; a `oneway` way produces only its travel direction (`b` when
 * `onewayReversed`, i.e. OSM `oneway=-1`).
 */
export function segmentsForWay(w: { oneway: boolean; onewayReversed?: boolean }): Dir[] {
  if (!w.oneway) return ["f", "b"];
  return w.onewayReversed ? ["b"] : ["f"];
}
