import type { Polygon, Position } from "geojson";
import { describe, expect, test } from "vitest";
import { representativePoint, simplifyGeometry, unionPolygons } from "../geometry.js";

/** A closed square ring of side `size` at `[x, y]`, with `steps` positions per side. */
function square(x: number, y: number, size: number, steps = 1): Position[] {
  const ring: Position[] = [];
  for (let i = 0; i < steps; i++) ring.push([x + (size * i) / steps, y]);
  for (let i = 0; i < steps; i++) ring.push([x + size, y + (size * i) / steps]);
  for (let i = 0; i < steps; i++) ring.push([x + size - (size * i) / steps, y + size]);
  for (let i = 0; i < steps; i++) ring.push([x, y + size - (size * i) / steps]);
  ring.push([x, y]);
  return ring;
}

const closed = (ring: readonly Position[]) =>
  ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1];

describe("simplifyGeometry", () => {
  test("drops the collinear positions of a ring and keeps it closed", () => {
    const polygon: Polygon = { type: "Polygon", coordinates: [square(10, 50, 1, 10)] };
    const out = simplifyGeometry(polygon, 0.005) as Polygon;
    expect(out.type).toBe("Polygon");
    const [ring] = out.coordinates;
    expect(closed(ring!)).toBe(true);
    expect(ring).toHaveLength(5);
    expect(ring).toEqual(
      expect.arrayContaining([
        [10, 50],
        [11, 50],
        [11, 51],
        [10, 51],
      ]),
    );
  });

  test("keeps a vertex that stands out more than the tolerance", () => {
    const ring: Position[] = [
      [0, 0],
      [0.5, 0.01],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    const out = simplifyGeometry({ type: "Polygon", coordinates: [ring] }, 0.005) as Polygon;
    expect(out.coordinates[0]).toContainEqual([0.5, 0.01]);
    const flat = simplifyGeometry({ type: "Polygon", coordinates: [ring] }, 0.05) as Polygon;
    expect(flat.coordinates[0]).not.toContainEqual([0.5, 0.01]);
  });

  test("drops a hole that collapses, and a polygon whose outer ring does", () => {
    const tiny = square(10.2, 50.2, 0.001);
    const out = simplifyGeometry(
      { type: "Polygon", coordinates: [square(10, 50, 1), tiny] },
      0.005,
    ) as Polygon;
    expect(out.coordinates).toHaveLength(1);
    expect(simplifyGeometry({ type: "Polygon", coordinates: [tiny] }, 0.005)).toBeNull();
    const multi = simplifyGeometry(
      { type: "MultiPolygon", coordinates: [[square(10, 50, 1)], [tiny]] },
      0.005,
    );
    expect(multi).toEqual({ type: "MultiPolygon", coordinates: [[square(10, 50, 1)]] });
  });

  test("keeps a hole that does not collapse as a ring of its own", () => {
    const hole = square(10.2, 50.2, 0.5, 5);
    const out = simplifyGeometry(
      { type: "MultiPolygon", coordinates: [[square(10, 50, 1), hole]] },
      0.005,
    );
    expect(out).toEqual({
      type: "MultiPolygon",
      coordinates: [[square(10, 50, 1), square(10.2, 50.2, 0.5)]],
    });
  });

  test("every ring it keeps has at least four positions", () => {
    // A thin sliver collapses to a line: it is dropped, never kept as a three-position ring.
    const sliver: Position[] = [
      [0, 0],
      [1, 0.001],
      [2, 0],
      [1, -0.001],
      [0, 0],
    ];
    expect(simplifyGeometry({ type: "Polygon", coordinates: [sliver] }, 0.005)).toBeNull();
    const triangle: Position[] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [0, 0],
    ];
    const out = simplifyGeometry({ type: "Polygon", coordinates: [triangle] }, 0.005) as Polygon;
    expect(out.coordinates[0]).toEqual(triangle);
  });

  test("leaves points as they are", () => {
    expect(simplifyGeometry({ type: "Point", coordinates: [1, 2] }, 0.005)).toEqual({
      type: "Point",
      coordinates: [1, 2],
    });
  });
});

describe("unionPolygons", () => {
  test("a Polygon and a MultiPolygon are a MultiPolygon of both, undissolved", () => {
    const a = square(0, 0, 1);
    const b = square(1, 0, 1);
    const c = square(5, 5, 1);
    expect(
      unionPolygons([
        { type: "Polygon", coordinates: [a] },
        { type: "MultiPolygon", coordinates: [[b], [c]] },
      ]),
    ).toEqual({ type: "MultiPolygon", coordinates: [[a], [b], [c]] });
  });

  test("one polygon stays a Polygon; nothing polygonal is null", () => {
    expect(unionPolygons([{ type: "Polygon", coordinates: [square(0, 0, 1)] }])).toEqual({
      type: "Polygon",
      coordinates: [square(0, 0, 1)],
    });
    expect(unionPolygons([{ type: "Point", coordinates: [0, 0] }])).toBeNull();
    expect(unionPolygons([])).toBeNull();
  });
});

describe("representativePoint", () => {
  test("is the centroid of a convex polygon", () => {
    expect(representativePoint({ type: "Polygon", coordinates: [square(10, 50, 2)] })).toEqual({
      type: "Point",
      coordinates: [11, 51],
    });
  });

  test("lies inside a U-shaped polygon whose centroid does not", () => {
    const u: Position[] = [
      [0, 0],
      [3, 0],
      [3, 3],
      [2, 3],
      [2, 1],
      [1, 1],
      [1, 3],
      [0, 3],
      [0, 0],
    ];
    const point = representativePoint({ type: "Polygon", coordinates: [u] })!;
    const [x, y] = point.coordinates as [number, number];
    const inArm = (x < 1 || x > 2) && x > 0 && x < 3 && y > 0 && y < 3;
    const inBase = y < 1 && y > 0 && x > 0 && x < 3;
    expect(inArm || inBase).toBe(true);
  });

  test("takes the largest polygon of several, and a point as itself", () => {
    const point = representativePoint({
      type: "MultiPolygon",
      coordinates: [[square(0, 0, 1)], [square(10, 10, 4)]],
    });
    expect(point).toEqual({ type: "Point", coordinates: [12, 12] });
    expect(representativePoint({ type: "Point", coordinates: [3, 4] })).toEqual({
      type: "Point",
      coordinates: [3, 4],
    });
  });
});
