import { describe, expect, it } from "vitest";
import { DirectionRef, datexLaneToIndex, locationSchemas } from "../kernel/location.js";
import { Geometry, Text, valueObjectSchemas } from "../kernel/scalars.js";
import { anyVocab } from "../kernel/vocab.js";

const { LocationRef } = locationSchemas(anyVocab, valueObjectSchemas(anyVocab));
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("scalars", () => {
  it("requires a primary-language entry and a BCP 47 tag", () => {
    expect(ok(Text, [{ lang: "de", text: "Köln" }])).toBe(true);
    expect(ok(Text, [])).toBe(false);
    expect(ok(Text, [{ lang: "german", text: "Köln" }])).toBe(false);
  });

  it("accepts RFC 7946 geometries and rejects open rings and nested collections", () => {
    expect(ok(Geometry, { type: "Point", coordinates: [6.96, 50.94, 54] })).toBe(true);
    expect(ok(Geometry, { type: "Point", coordinates: [200, 50] })).toBe(false);
    const open = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ];
    expect(ok(Geometry, { type: "Polygon", coordinates: open })).toBe(false);
    const nested = {
      type: "GeometryCollection",
      geometries: [{ type: "GeometryCollection", geometries: [] }],
    };
    expect(ok(Geometry, nested)).toBe(false);
  });
});

describe("location", () => {
  it("forbids a signed direction on an axis-less basis", () => {
    expect(ok(DirectionRef, { value: "positive", basis: "compass", compass: "N" })).toBe(false);
    expect(ok(DirectionRef, { value: "unknown", basis: "compass", compass: "N" })).toBe(true);
    expect(ok(DirectionRef, { value: "positive", basis: "road_reference" })).toBe(true);
  });

  it("keeps extent none, null geometry and geometryOrigin none consistent", () => {
    const none = { geometry: null, extent: "none", geometryOrigin: "none", fuzziness: "exact" };
    expect(ok(LocationRef, none)).toBe(true);
    expect(ok(LocationRef, { ...none, geometryOrigin: "source" })).toBe(false);
    const tmcOnly = { ...none, extent: "linear", tmc: { country: "DE", table: 1, code: 12345 } };
    expect(ok(LocationRef, tmcOnly)).toBe(true);
  });

  it("takes a linear reference on any linear feature, road or waterway", () => {
    const gauge = {
      geometry: { type: "Point", coordinates: [6.9633, 50.936949] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
      linear: { system: "kilometre_post", ref: "RHEIN", from: 688 },
    };
    expect(ok(LocationRef, gauge)).toBe(true);
  });

  it("holds only osm:* ids in osm", () => {
    const base = {
      geometry: { type: "Point", coordinates: [8, 50] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
    };
    expect(ok(LocationRef, { ...base, osm: [{ scheme: "osm:way", id: "1" }] })).toBe(true);
    expect(ok(LocationRef, { ...base, osm: [{ scheme: "gers", id: "1" }] })).toBe(false);
  });

  it.each([
    [1, { drivingSide: "right" as const, lanesTotal: 3 }, 3],
    [3, { drivingSide: "right" as const, lanesTotal: 3 }, 1],
    [1, { drivingSide: "right" as const }, null],
    [1, { drivingSide: "right" as const, lanesTotal: 3, numbering: "left_first" as const }, 1],
    [1, { drivingSide: "left" as const }, 1],
    [4, { drivingSide: "right" as const, lanesTotal: 3 }, null],
  ])("converts DATEX lane %i with %o to OC index %s", (lane, opts, index) => {
    expect(datexLaneToIndex(lane, opts)).toBe(index);
  });
});
