import { describe, expect, it } from "vitest";
import { checkPlausibility } from "../plausibility.js";
import type { ReportClaim } from "../types.js";

const NOW = "2026-07-12T08:00:00.000Z";

function claim(overrides: Partial<ReportClaim> = {}): ReportClaim {
  return {
    domain: "roads",
    type: "congestion",
    geometry: { type: "Point", coordinates: [4.9, 52.37] },
    fuzziness: "low_res",
    reportedAt: "2026-07-12T07:59:00.000Z",
    nonce: "abcdefghijklmnop",
    ...overrides,
  };
}

describe("checkPlausibility", () => {
  it("passes a clean report", () => {
    const result = checkPlausibility(claim(), NOW);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects a longitude out of WGS84 range", () => {
    const result = checkPlausibility(
      claim({ geometry: { type: "Point", coordinates: [181, 52] } }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_out_of_range");
  });

  it("rejects a latitude out of WGS84 range", () => {
    const result = checkPlausibility(
      claim({ geometry: { type: "Point", coordinates: [4, 91] } }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_out_of_range");
  });

  it("rejects a non-finite coordinate", () => {
    const result = checkPlausibility(
      claim({ geometry: { type: "Point", coordinates: [Number.NaN, 52] } }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_not_finite");
  });

  it("validates coordinates inside a nested geometry (LineString)", () => {
    const ok = checkPlausibility(
      claim({
        geometry: {
          type: "LineString",
          coordinates: [
            [4, 52],
            [4.1, 52.1],
          ],
        },
      }),
      NOW
    );
    expect(ok.ok).toBe(true);

    const bad = checkPlausibility(
      claim({
        geometry: {
          type: "LineString",
          coordinates: [
            [4, 52],
            [200, 52.1],
          ],
        },
      }),
      NOW
    );
    expect(bad.ok).toBe(false);
    expect(bad.reasons).toContain("geometry_out_of_range");
  });

  it("rejects a geometry with no positions", () => {
    const result = checkPlausibility(
      claim({ geometry: { type: "LineString", coordinates: [] } }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_empty");
  });

  it("rejects a Point whose coordinates are nested (type/arity mismatch)", () => {
    const result = checkPlausibility(
      claim({ geometry: { type: "Point", coordinates: [[4.9, 52.37]] } as never }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_malformed");
  });

  it("rejects a 3-ordinate position (v1 is 2D)", () => {
    const result = checkPlausibility(
      claim({ geometry: { type: "Point", coordinates: [4.9, 52.37, 12] } as never }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_malformed");
  });

  it("rejects a LineString with a single position", () => {
    const result = checkPlausibility(
      claim({ geometry: { type: "LineString", coordinates: [[4, 52]] } }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_malformed");
  });

  it("rejects an unclosed Polygon ring", () => {
    const result = checkPlausibility(
      claim({
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [4, 52],
              [4.1, 52],
              [4.1, 52.1],
              [4, 52.1],
            ],
          ],
        },
      }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_malformed");
  });

  it("rejects a Polygon ring with fewer than 4 positions", () => {
    const result = checkPlausibility(
      claim({
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [4, 52],
              [4.1, 52],
              [4, 52],
            ],
          ],
        },
      }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_malformed");
  });

  it("rejects a GeometryCollection with a malformed member", () => {
    const result = checkPlausibility(
      claim({
        geometry: {
          type: "GeometryCollection",
          geometries: [
            { type: "Point", coordinates: [4, 52] },
            { type: "LineString", coordinates: [[4, 52]] },
          ],
        },
      }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_malformed");
  });

  it("accepts a valid geometry of each type", () => {
    const closedRing = [
      [4, 52],
      [4.1, 52],
      [4.1, 52.1],
      [4, 52],
    ];
    const geometries: ReportClaim["geometry"][] = [
      { type: "Point", coordinates: [4, 52] },
      {
        type: "MultiPoint",
        coordinates: [
          [4, 52],
          [4.1, 52.1],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [4, 52],
          [4.1, 52.1],
        ],
      },
      {
        type: "MultiLineString",
        coordinates: [
          [
            [4, 52],
            [4.1, 52.1],
          ],
        ],
      },
      { type: "Polygon", coordinates: [closedRing] },
      { type: "MultiPolygon", coordinates: [[closedRing]] },
      {
        type: "GeometryCollection",
        geometries: [{ type: "Point", coordinates: [4, 52] }],
      },
    ];
    for (const geometry of geometries) {
      const result = checkPlausibility(claim({ geometry }), NOW);
      expect(result.ok, `expected ${geometry.type} to pass`).toBe(true);
    }
  });

  it("rejects a report older than 24h", () => {
    const result = checkPlausibility(claim({ reportedAt: "2026-07-11T07:00:00.000Z" }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("reported_at_stale");
  });

  it("rejects a report more than 5 minutes in the future", () => {
    const result = checkPlausibility(claim({ reportedAt: "2026-07-12T08:06:00.000Z" }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("reported_at_future");
  });

  it("allows a report exactly at the 5-minute future edge", () => {
    const result = checkPlausibility(claim({ reportedAt: "2026-07-12T08:05:00.000Z" }), NOW);
    expect(result.ok).toBe(true);
  });

  it("rejects an unparseable reportedAt", () => {
    const result = checkPlausibility(claim({ reportedAt: "not-a-date" }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("reported_at_invalid");
  });

  it("rejects a malformed nonce", () => {
    const result = checkPlausibility(claim({ nonce: "short" }), NOW);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("nonce_malformed");
  });

  it("accumulates multiple reasons", () => {
    const result = checkPlausibility(
      claim({
        geometry: { type: "Point", coordinates: [999, 52] },
        nonce: "!!",
      }),
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("geometry_out_of_range");
    expect(result.reasons).toContain("nonce_malformed");
  });
});
