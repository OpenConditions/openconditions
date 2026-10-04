import { describe, expect, test } from "vitest";
import { decodeOverpass } from "../layouts/overpass.js";

const body = (doc: unknown) => Buffer.from(JSON.stringify(doc));

describe("decodeOverpass", () => {
  test("decodeOverpass reads nodes and way centres and skips positionless elements", () => {
    const elements = decodeOverpass(
      body({
        elements: [
          { type: "node", id: 1, lat: 52.5, lon: 13.4, tags: { amenity: "fuel" } },
          { type: "way", id: 2, center: { lat: 48.1, lon: 11.6 }, tags: { brand: "X" } },
          { type: "relation", id: 3, tags: { amenity: "fuel" } },
          { type: "node", id: 4, lat: 1, lon: 2 },
        ],
      }),
    );
    expect(elements).toEqual([
      { type: "node", id: 1, lat: 52.5, lon: 13.4, tags: { amenity: "fuel" } },
      { type: "way", id: 2, lat: 48.1, lon: 11.6, tags: { brand: "X" } },
      { type: "node", id: 4, lat: 1, lon: 2, tags: {} },
    ]);
  });

  test("decodeOverpass throws on an Overpass runtime error remark", () => {
    expect(() =>
      decodeOverpass(body({ elements: [], remark: "runtime error: Query timed out" })),
    ).toThrow(/runtime error/);
  });

  test("decodeOverpass skips an element whose id is not a positive safe integer", () => {
    const ids = [0, -1, 1.5, 2 ** 53, 7];
    const elements = decodeOverpass(
      body({ elements: ids.map((id) => ({ type: "node", id, lat: 1, lon: 2 })) }),
    );
    expect(elements.map((e) => e.id)).toEqual([7]);
  });

  test("another remark is not an error", () => {
    expect(decodeOverpass(body({ elements: [], remark: "note" }))).toEqual([]);
  });
});
