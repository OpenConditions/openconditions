import { describe, expect, it } from "vitest";
import { type LngLat, projectOntoPolyline } from "../geo.js";
import { SegmentGrid } from "../segment-grid.js";
import type { SpineSegment } from "../types.js";

/** A deterministic pseudo-random sequence, so a failure reproduces. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function segment(id: number, coords: LngLat[]): SpineSegment {
  return {
    segmentId: `s${id}`,
    wayId: id,
    dir: "f",
    highway: "motorway",
    ref: null,
    coords,
    lengthM: 0,
  };
}

/** Random short polylines scattered over a box at latitude `lat`. */
function scatter(next: () => number, lat: number, count: number): SpineSegment[] {
  return Array.from({ length: count }, (_, id) => {
    const start: LngLat = [10 + next() * 0.2, lat + next() * 0.2];
    const coords: LngLat[] = [start];
    for (let v = 0; v < 1 + Math.floor(next() * 5); v++) {
      const last = coords.at(-1)!;
      coords.push([last[0] + (next() - 0.5) * 0.004, last[1] + (next() - 0.5) * 0.004]);
    }
    return segment(id, coords);
  });
}

describe("SegmentGrid", () => {
  for (const lat of [0, 51, 69]) {
    it(`never misses a segment within reach of a point at ${lat}°`, () => {
      const next = lcg(lat + 7);
      const segments = scatter(next, lat, 600);
      const reachM = 40;
      const grid = new SegmentGrid(segments, reachM);
      let within = 0;
      for (let i = 0; i < 400; i++) {
        const p: LngLat = [10 + next() * 0.2, lat + next() * 0.2];
        const near = new Set(grid.near(p));
        for (const s of segments) {
          if (projectOntoPolyline(p, s.coords).offsetM > reachM) continue;
          within++;
          expect(near.has(s)).toBe(true);
        }
      }
      expect(within).toBeGreaterThan(10);
    });
  }

  it("leaves out segments far from the point and keeps the spine's order", () => {
    const a = segment(1, [
      [10, 51],
      [10.001, 51],
    ]);
    const far = segment(2, [
      [10.2, 51.2],
      [10.201, 51.2],
    ]);
    const b = segment(3, [
      [10.0005, 51],
      [10.0005, 51.001],
    ]);
    expect(new SegmentGrid([a, far, b], 40).near([10.0005, 51.0001])).toEqual([a, b]);
  });

  it("finds nothing away from every segment", () => {
    const grid = new SegmentGrid(
      [
        segment(1, [
          [10, 51],
          [10.001, 51],
        ]),
      ],
      40,
    );
    expect(grid.near([11, 52])).toEqual([]);
  });
});
