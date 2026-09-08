/**
 * Directed segment graph over the spine subgraph loaded for one event, plus a
 * bounded Dijkstra used to reconstruct the road path between two matched
 * candidates. Nodes are segment ids; a segment's coordinates always run in
 * travel direction (`b` segments carry reversed geometry), so an edge exists
 * from A to B whenever A's last coordinate is B's first.
 */

import type { LngLat } from "./geo.js";
import type { SpineSegment } from "./types.js";

/** Endpoint identity for adjacency: coordinates rounded to 1e-7 degrees. */
export function nodeKey(p: LngLat): string {
  return `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
}

/** Directed adjacency over spine segments: A → B when A's last coordinate equals B's first. */
export class SegmentGraph {
  private readonly segments = new Map<string, SpineSegment>();
  private readonly outByStart = new Map<string, SpineSegment[]>();

  constructor(segments: SpineSegment[]) {
    for (const s of segments) {
      if (s.coords.length < 2) continue;
      this.segments.set(s.segmentId, s);
      const k = nodeKey(s.coords[0]!);
      const list = this.outByStart.get(k);
      if (list) list.push(s);
      else this.outByStart.set(k, [s]);
    }
  }

  byId(id: string): SpineSegment | undefined {
    return this.segments.get(id);
  }

  successors(id: string): SpineSegment[] {
    const s = this.segments.get(id);
    if (!s) return [];
    return (this.outByStart.get(nodeKey(s.coords[s.coords.length - 1]!)) ?? []).filter(
      (n) => n.segmentId !== id
    );
  }

  /**
   * Dijkstra by segment length from `from` to `to`, both inclusive. Cost of a
   * path is the sum of the lengths of every segment after `from`. Returns null
   * when no path exists within `maxLengthM` or when `allow` rejects every route.
   * The subgraph is small (a few thousand segments) so a simple O(n²) selection
   * of the next open node is fine.
   */
  shortestPath(
    from: string,
    to: string,
    maxLengthM: number,
    allow: (s: SpineSegment) => boolean = () => true
  ): SpineSegment[] | null {
    if (!this.segments.has(from) || !this.segments.has(to)) return null;
    if (from === to) return [this.segments.get(from)!];
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, string>();
    const open = new Set<string>([from]);
    const done = new Set<string>();
    while (open.size > 0) {
      let cur: string | null = null;
      let best = Infinity;
      for (const id of open) {
        const d = dist.get(id)!;
        if (d < best) {
          best = d;
          cur = id;
        }
      }
      if (cur === null) break;
      open.delete(cur);
      done.add(cur);
      if (cur === to) break;
      for (const next of this.successors(cur)) {
        if (done.has(next.segmentId) || !allow(next)) continue;
        const nd = best + next.lengthM;
        if (nd > maxLengthM) continue;
        if (nd < (dist.get(next.segmentId) ?? Infinity)) {
          dist.set(next.segmentId, nd);
          prev.set(next.segmentId, cur);
          open.add(next.segmentId);
        }
      }
    }
    if (!dist.has(to)) return null;
    const path: SpineSegment[] = [];
    for (let id: string | undefined = to; id !== undefined; id = prev.get(id)) {
      path.unshift(this.segments.get(id)!);
      if (id === from) break;
    }
    return path[0]?.segmentId === from ? path : null;
  }
}
