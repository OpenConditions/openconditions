import { describe, expect, test } from "vitest";
import { cellCount, cellRadiusKm, cellsCovering, cellValues } from "../catalog/cells.js";

describe("cells", () => {
  test("cells tile a bbox on a fixed grid", () => {
    const cells = cellsCovering([13.3, 52.45, 13.55, 52.6], 0.25);
    expect(cells.map((c) => c.id)).toEqual([
      "0.25/53/209",
      "0.25/54/209",
      "0.25/53/210",
      "0.25/54/210",
    ]);
    expect(cells[0]).toMatchObject({ west: 13.25, south: 52.25, east: 13.5, north: 52.5 });
  });

  test("a bbox ending on a grid line does not take the next cell", () => {
    expect(cellsCovering([13.25, 52.25, 13.5, 52.5], 0.25).map((c) => c.id)).toEqual([
      "0.25/53/209",
    ]);
  });

  test("a bbox edge on a 0.1 grid line adds no spurious cell", () => {
    expect(cellsCovering([0.3, 0.3, 0.5, 0.5], 0.1).map((c) => c.id)).toEqual([
      "0.1/3/3",
      "0.1/4/3",
      "0.1/3/4",
      "0.1/4/4",
    ]);
  });

  test("negative coordinates on grid lines add no spurious cell", () => {
    expect(cellsCovering([-0.5, -0.5, -0.3, -0.3], 0.1).map((c) => c.id)).toEqual([
      "0.1/-5/-5",
      "0.1/-4/-5",
      "0.1/-5/-4",
      "0.1/-4/-4",
    ]);
    expect(cellsCovering([-0.3, 0.3, 0.1, 0.4], 0.1).map((c) => c.id)).toEqual([
      "0.1/-3/3",
      "0.1/-2/3",
      "0.1/-1/3",
      "0.1/0/3",
    ]);
  });

  test("cell edges carry no float noise", () => {
    const [cell] = cellsCovering([0.35, 0.35, 0.36, 0.36], 0.1);
    expect(cell).toMatchObject({ west: 0.3, south: 0.3, east: 0.4, north: 0.4 });
  });

  test("cellCount counts the cells cellsCovering builds, without building them", () => {
    const boxes: [number, number, number, number][] = [
      [13.3, 52.45, 13.55, 52.6],
      [13.25, 52.25, 13.5, 52.5],
      [0.3, 0.3, 0.5, 0.5],
      [-0.5, -0.5, -0.3, -0.3],
      [-0.3, 0.3, 0.1, 0.4],
      [0.35, 0.35, 0.36, 0.36],
      [8, 49, 8, 49],
    ];
    for (const box of boxes) {
      for (const deg of [0.1, 0.25]) {
        expect(cellCount(box, deg)).toBe(cellsCovering(box, deg).length);
      }
    }
    // The whole world on a 0.1° grid: 3600 x 1800 cells, counted at once.
    expect(cellCount([-180, -90, 180, 90], 0.1)).toBe(6_480_000);
  });

  test("a cell's radius reaches its corners", () => {
    expect(cellRadiusKm({ id: "x", west: 0, south: 0, east: 0.25, north: 0.25 })).toBeCloseTo(
      19.7,
      0,
    );
  });

  test("a cell at the antimeridian or a pole is filled with edges inside the valid range", () => {
    const [northEast] = cellsCovering([180, 90, 180, 90], 0.1);
    expect(northEast).toMatchObject({ west: 180, south: 90 });
    expect(cellValues(northEast!)).toMatchObject({
      west: "180",
      south: "90",
      east: "180",
      north: "90",
      lon: "180",
      lat: "90",
    });
    const [southWest] = cellsCovering([-180.05, -90.05, -180.05, -90.05], 0.1);
    expect(cellValues(southWest!)).toMatchObject({
      west: "-180",
      south: "-90",
      east: "-180",
      north: "-90",
    });
    const [nearPole] = cellsCovering([10, 89.95, 10, 89.95], 0.1);
    expect(cellValues(nearPole!)).toMatchObject({ south: "89.9", north: "90", lat: "89.95" });
  });
});
