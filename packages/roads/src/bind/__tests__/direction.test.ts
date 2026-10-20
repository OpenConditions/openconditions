import type { Geometry } from "geojson";
import { describe, expect, it } from "vitest";
import { bindEvent, toBindInput } from "../bind-event.js";
import { type TravelDirection, travelDirectionOf } from "../direction.js";
import type { SpineSegment, SpineSubgraph } from "../types.js";

describe("travelDirectionOf", () => {
  const alertC = (value: string) => ({ value, basis: "alert_c" });

  it("narrows nothing without a direction, for both ways, or for text it cannot read", () => {
    expect(travelDirectionOf(undefined)).toBeUndefined();
    expect(travelDirectionOf({ value: "both", basis: "text", text: "both" })).toBeUndefined();
    expect(travelDirectionOf({ value: "unknown", basis: "text", text: "Köln" })).toBeUndefined();
    expect(travelDirectionOf({ value: "unknown", basis: "text", loop: "inner" })).toBeUndefined();
    expect(travelDirectionOf({ value: "unknown", basis: "unknown" })).toBeUndefined();
  });

  it("reads a heading from a compass point or a bearing", () => {
    expect(travelDirectionOf({ value: "unknown", basis: "compass", compass: "SE" })).toEqual({
      kind: "heading",
      bearingDeg: 135,
    });
    expect(travelDirectionOf({ value: "unknown", basis: "bearing", bearingDeg: 270 })).toEqual({
      kind: "heading",
      bearingDeg: 270,
    });
  });

  it("does not take a compass point from an inherited key", () => {
    expect(
      travelDirectionOf({ value: "unknown", basis: "compass", compass: "constructor" }),
    ).toBeUndefined();
  });

  it("reads the geometry's order as along it, and its reverse as against it", () => {
    expect(travelDirectionOf({ value: "positive", basis: "geometry" })).toEqual({ kind: "along" });
    expect(travelDirectionOf({ value: "negative", basis: "geometry" })).toEqual({
      kind: "against",
    });
  });

  it("keeps a single direction along an axis the geometry does not carry", () => {
    expect(travelDirectionOf(alertC("positive"))).toEqual({ kind: "one" });
    expect(travelDirectionOf({ value: "negative", basis: "road_reference" })).toEqual({
      kind: "one",
    });
  });

  it("lets the effect's own direction replace its location's", () => {
    const location = { value: "unknown", basis: "compass", compass: "N" };
    expect(
      travelDirectionOf(location, { value: "unknown", basis: "compass", compass: "S" }),
    ).toEqual({ kind: "heading", bearingDeg: 180 });
    expect(travelDirectionOf(alertC("positive"), alertC("positive"))).toEqual({ kind: "one" });
    expect(
      travelDirectionOf(alertC("both"), { value: "unknown", basis: "compass", compass: "E" }),
    ).toEqual({ kind: "heading", bearingDeg: 90 });
  });

  it("does not narrow an effect that applies both ways", () => {
    expect(
      travelDirectionOf(alertC("positive"), { value: "both", basis: "text", text: "bothWays" }),
    ).toBeUndefined();
  });

  it("keeps the location's direction where the effect's says nothing", () => {
    expect(
      travelDirectionOf(alertC("positive"), { value: "unknown", basis: "text", text: "opposite" }),
    ).toEqual({ kind: "one" });
    expect(
      travelDirectionOf(undefined, { value: "unknown", basis: "text", text: "opposite" }),
    ).toBeUndefined();
  });

  it("reads an effect on the other side of its location's axis as against it", () => {
    expect(travelDirectionOf(alertC("positive"), alertC("negative"))).toEqual({
      kind: "against",
    });
    // Different axes cannot be compared: the effect's single direction stands.
    expect(
      travelDirectionOf(alertC("positive"), { value: "negative", basis: "road_reference" }),
    ).toEqual({ kind: "one" });
  });
});

function seg(id: string, coords: [number, number][], ref: string): SpineSegment {
  const [wayId, dir] = id.split(":");
  return {
    segmentId: id,
    wayId: Number(wayId),
    dir: dir as "f" | "b",
    highway: "primary",
    ref,
    coords,
    lengthM: 2100,
  };
}

// A bidirectional road running east (f) and west (b) along lat 51.197.
const twoWay: SpineSubgraph = {
  segments: [
    seg(
      "30:f",
      [
        [6.8, 51.197],
        [6.83, 51.197],
      ],
      "B 9",
    ),
    seg(
      "30:b",
      [
        [6.83, 51.197],
        [6.8, 51.197],
      ],
      "B 9",
    ),
  ],
};

const bind = (geometry: Geometry, travel?: TravelDirection) =>
  bindEvent(
    toBindInput({
      id: "e",
      type: "road_closure",
      roads: [{ ref: "B 9" }],
      geometry,
      ...(travel ? { travel } : {}),
    }),
    twoWay,
  );

const POINT: Geometry = { type: "Point", coordinates: [6.815, 51.19701] };
const EAST: Geometry = {
  type: "LineString",
  coordinates: [
    [6.81, 51.19701],
    [6.82, 51.19701],
  ],
};
const ROUTED = ["exact", "likely"];

describe("binding in the stated direction of travel", () => {
  it("binds both directions of a point on a two-way road when nothing narrows it", () => {
    const r = bind(POINT);
    expect(r.directionMode).toBe("both");
    expect(r.segments.map((s) => s.segmentId).sort()).toEqual(["30:b", "30:f"]);
    expect(ROUTED).toContain(r.status);
  });

  it("keeps the carriageway a stated heading runs along", () => {
    const both = bind(POINT);
    const east = bind(POINT, { kind: "heading", bearingDeg: 90 });
    expect(east.directionMode).toBe("single");
    expect(east.segments.map((s) => s.segmentId)).toEqual(["30:f"]);
    expect(ROUTED).toContain(east.status);
    expect(east.confidence).toBeGreaterThan(both.confidence!);

    const west = bind(POINT, { kind: "heading", bearingDeg: 270 });
    expect(west.segments.map((s) => s.segmentId)).toEqual(["30:b"]);
    // A signed direction is coarse: a heading within 60° still picks the side.
    expect(bind(POINT, { kind: "heading", bearingDeg: 45 }).segments).toHaveLength(1);
  });

  it("leaves the direction unknown where a heading fits neither carriageway", () => {
    const r = bind(POINT, { kind: "heading", bearingDeg: 0 });
    expect(r.directionMode).toBe("unknown");
    expect(r.status).toBe("ambiguous");
    expect(r.reason).toBe("direction_undecided");
    expect(r.confidence).toBeLessThan(0.7);
    expect(r.segments).toHaveLength(2);
  });

  it("does not close both sides of a point for one direction it cannot place", () => {
    for (const travel of [{ kind: "one" }, { kind: "along" }] as const) {
      const r = bind(POINT, travel);
      expect(r.directionMode).toBe("unknown");
      expect(r.status).toBe("ambiguous");
      expect(r.reason).toBe("direction_undecided");
    }
  });

  it("reads a short line's own order where the geometry's order is the direction", () => {
    const shortWest: Geometry = {
      type: "LineString",
      coordinates: [
        [6.81509, 51.19701],
        [6.815, 51.19701],
      ],
    };
    const both = bind(shortWest);
    expect(both.directionMode).toBe("both");
    const along = bind(shortWest, { kind: "along" });
    expect(along.directionMode).toBe("single");
    expect(along.segments.map((s) => s.segmentId)).toEqual(["30:b"]);
  });

  it("keeps a drawn line's direction when the stated one agrees or cannot be compared", () => {
    const plain = bind(EAST);
    expect(plain.directionMode).toBe("single");
    expect(plain.segments.map((s) => s.segmentId)).toEqual(["30:f"]);
    for (const travel of [
      { kind: "one" },
      { kind: "along" },
      { kind: "heading", bearingDeg: 90 },
      // A signed direction may differ from the local heading of the road.
      { kind: "heading", bearingDeg: 180 },
    ] as const) {
      expect(bind(EAST, travel)).toEqual(plain);
    }
  });

  it("reports rather than binds a stated direction against the drawn line", () => {
    for (const travel of [{ kind: "against" }, { kind: "heading", bearingDeg: 270 }] as const) {
      const r = bind(EAST, travel);
      expect(r.status).toBe("unresolved");
      expect(r.reason).toBe("conflicting_direction");
      expect(r.segments).toEqual([]);
      expect(r.confidence).toBeNull();
    }
    expect(bind(POINT, { kind: "against" }).reason).toBe("conflicting_direction");
  });

  it("holds an endpoint pair against a stated heading like a drawn line", () => {
    const pair: Geometry = {
      type: "MultiPoint",
      coordinates: [
        [6.82, 51.19701],
        [6.81, 51.19701],
      ],
    };
    expect(bind(pair).segments.map((s) => s.segmentId)).toEqual(["30:b"]);
    expect(bind(pair, { kind: "heading", bearingDeg: 270 }).segments).toHaveLength(1);
    expect(bind(pair, { kind: "heading", bearingDeg: 90 }).reason).toBe("conflicting_direction");
  });

  it("leaves a failure as it is", () => {
    const far: Geometry = { type: "Point", coordinates: [7.5, 52] };
    expect(bind(far, { kind: "against" }).reason).toBe("no_candidates");
  });
});
