import { describe, expect, it } from "vitest";
import { SegmentGraph, nodeKey } from "../graph.js";
import type { SpineSegment } from "../types.js";

function seg(id: string, coords: [number, number][], ref = "A1"): SpineSegment {
  const [wayId, dir] = id.split(":");
  return {
    segmentId: id,
    wayId: Number(wayId),
    dir: dir as "f" | "b",
    highway: "motorway",
    ref,
    coords,
    lengthM: coords.length * 100,
  };
}

describe("SegmentGraph", () => {
  const a = seg("1:f", [
    [6.8, 51.2],
    [6.81, 51.2],
  ]);
  const b = seg("2:f", [
    [6.81, 51.2],
    [6.82, 51.2],
  ]);
  const c = seg("3:f", [
    [6.82, 51.2],
    [6.83, 51.2],
  ]);
  const detour = seg("4:f", [
    [6.81, 51.2],
    [6.81, 51.21],
    [6.82, 51.21],
    [6.82, 51.2],
  ]);
  const g = new SegmentGraph([a, b, c, detour]);

  it("links segments whose end/start coordinates coincide", () => {
    expect(
      g
        .successors("1:f")
        .map((s) => s.segmentId)
        .sort()
    ).toEqual(["2:f", "4:f"]);
    expect(g.successors("3:f")).toEqual([]);
  });

  it("finds the shortest path and respects the length cap", () => {
    expect(g.shortestPath("1:f", "3:f", 10_000)!.map((s) => s.segmentId)).toEqual([
      "1:f",
      "2:f",
      "3:f",
    ]);
    expect(g.shortestPath("1:f", "3:f", 250)).toBeNull();
  });

  it("honours the allow predicate (e.g. same ref)", () => {
    const path = g.shortestPath("1:f", "3:f", 10_000, (s) => s.segmentId !== "2:f");
    expect(path!.map((s) => s.segmentId)).toEqual(["1:f", "4:f", "3:f"]);
  });

  it("nodeKey rounds to 1e-7", () => {
    expect(nodeKey([6.80000004, 51.2])).toBe(nodeKey([6.8, 51.20000001]));
  });

  it("looks segments up by id and ignores unknown ids", () => {
    expect(g.byId("2:f")).toBe(b);
    expect(g.byId("9:f")).toBeUndefined();
    expect(g.successors("9:f")).toEqual([]);
    expect(g.shortestPath("9:f", "3:f", 10_000)).toBeNull();
    expect(g.shortestPath("1:f", "9:f", 10_000)).toBeNull();
  });

  it("a path to itself is the segment alone", () => {
    expect(g.shortestPath("2:f", "2:f", 0)).toEqual([b]);
  });

  it("admits a path whose cost exactly equals the cap and rejects one metre less", () => {
    expect(g.shortestPath("1:f", "3:f", 400)!.map((s) => s.segmentId)).toEqual([
      "1:f",
      "2:f",
      "3:f",
    ]);
    expect(g.shortestPath("1:f", "3:f", 399)).toBeNull();
  });

  it("returns null when no route reaches the target", () => {
    expect(g.shortestPath("3:f", "1:f", 10_000)).toBeNull();
  });

  it("drops segments with fewer than two coordinates", () => {
    const stub = seg("5:f", [[6.83, 51.2]]);
    const withStub = new SegmentGraph([a, b, c, stub]);
    expect(withStub.byId("5:f")).toBeUndefined();
    expect(withStub.successors("3:f")).toEqual([]);
  });
});
