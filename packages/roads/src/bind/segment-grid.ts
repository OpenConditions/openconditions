import { bboxOf, type LngLat } from "./geo.js";
import type { SpineSegment } from "./types.js";

/** Grid cell edge, in degrees. */
const CELL_DEG = 0.01;
/**
 * Fewest metres a degree of latitude spans, rounded down; a degree of
 * longitude spans this times the cosine of its latitude.
 */
const MIN_METRES_PER_DEGREE = 110_000;

function cellKey(ix: number, iy: number): number {
  return (ix + 20_000) * 40_000 + (iy + 20_000);
}

/**
 * The segments of a subgraph by grid cell, so a point is tested only against
 * the segments that could lie within `reachM` of it rather than against all of
 * them. Each segment is filed under every cell its bounding box, widened by
 * `reachM` with room to spare, touches: a segment within reach of a point is
 * always among those `near` returns. Every list keeps the subgraph's order.
 */
export class SegmentGrid {
  private readonly cells = new Map<number, SpineSegment[]>();

  constructor(segments: readonly SpineSegment[], reachM: number) {
    for (const s of segments) {
      if (s.coords.length === 0) continue;
      const [w, south, e, north] = bboxOf(s.coords);
      const dLat = reachM / MIN_METRES_PER_DEGREE;
      const maxLat = Math.min(89.9, Math.max(Math.abs(south), Math.abs(north)) + dLat);
      // 0.9 covers the gap between a planar degree and the haversine metre.
      const dLng = reachM / (0.9 * MIN_METRES_PER_DEGREE * Math.cos((maxLat * Math.PI) / 180));
      const x0 = Math.floor((w - dLng) / CELL_DEG);
      const x1 = Math.floor((e + dLng) / CELL_DEG);
      const y0 = Math.floor((south - dLat) / CELL_DEG);
      const y1 = Math.floor((north + dLat) / CELL_DEG);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          const key = cellKey(ix, iy);
          const cell = this.cells.get(key);
          if (cell) cell.push(s);
          else this.cells.set(key, [s]);
        }
      }
    }
  }

  /** Every segment that could lie within reach of `p`, in subgraph order. */
  near(p: LngLat): readonly SpineSegment[] {
    return this.cells.get(cellKey(Math.floor(p[0] / CELL_DEG), Math.floor(p[1] / CELL_DEG))) ?? [];
  }
}
