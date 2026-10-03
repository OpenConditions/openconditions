import { describe, expect, it } from "vitest";
import {
  distanceToGeometryMetres,
  observationConfirms,
  resultsAgree,
  situationsAgree,
} from "../crowd/agree.js";
import { crowdRegistry } from "./crowd-fixtures.js";

/** About 111 m per 0.001° of latitude. */
const NORTH_100M = 0.0009;

describe("distance to a geometry", () => {
  it("measures to the nearest vertex, segment or polygon edge, and is zero inside", () => {
    expect(
      distanceToGeometryMetres([8.4, 49], { type: "Point", coordinates: [8.4, 49 + NORTH_100M] }),
    ).toBeCloseTo(100, -1);
    const road = {
      type: "LineString",
      coordinates: [
        [8.39, 49 + NORTH_100M],
        [8.41, 49 + NORTH_100M],
      ],
    };
    expect(distanceToGeometryMetres([8.4, 49], road)).toBeCloseTo(100, -1);
    const square = {
      type: "Polygon",
      coordinates: [
        [
          [8.39, 48.99],
          [8.41, 48.99],
          [8.41, 49.01],
          [8.39, 49.01],
          [8.39, 48.99],
        ],
      ],
    };
    expect(distanceToGeometryMetres([8.4, 49], square)).toBe(0);
    expect(distanceToGeometryMetres([8.4, 49.01 + NORTH_100M], square)).toBeCloseTo(100, -1);
  });

  it("measures across the antimeridian the short way round", () => {
    expect(
      distanceToGeometryMetres([179.9995, 0], { type: "Point", coordinates: [-179.9995, 0] }),
    ).toBeCloseTo(111, -1);
  });
});

const crowdAccident = {
  kind: "incident",
  type: "accident",
  location: { geometry: { type: "Point", coordinates: [8.4, 49] } },
  validity: { status: "active" as const, start: "2026-10-01T11:58:00Z" },
};

describe("situations agree", () => {
  const feed = (overrides: Record<string, unknown> = {}) => ({
    ...crowdAccident,
    location: {
      geometry: {
        type: "LineString",
        coordinates: [
          [8.39, 49 + NORTH_100M],
          [8.41, 49 + NORTH_100M],
        ],
      },
    },
    validity: {
      status: "active" as const,
      start: "2026-10-01T11:40:00Z",
      end: "2026-10-01T14:00:00Z",
    },
    ...overrides,
  });

  it("when the other is the same kind and type, in effect then, and near where it was reported", () => {
    expect(situationsAgree(crowdRegistry, crowdAccident, feed())).toBe(true);
    expect(situationsAgree(crowdRegistry, crowdAccident, feed({ type: "obstruction" }))).toBe(
      false,
    );
    expect(
      situationsAgree(
        crowdRegistry,
        crowdAccident,
        feed({ validity: { status: "active", start: "2026-10-01T12:30:00Z" } }),
      ),
    ).toBe(false);
    expect(
      situationsAgree(
        crowdRegistry,
        crowdAccident,
        feed({ location: { geometry: { type: "Point", coordinates: [8.4, 49.003] } } }),
      ),
    ).toBe(false);
    expect(
      situationsAgree(crowdRegistry, crowdAccident, feed({ location: { geometry: null } })),
    ).toBe(false);
  });

  it("anchors a report drawn across the antimeridian on its line", () => {
    const across = {
      ...crowdAccident,
      location: {
        geometry: {
          type: "LineString",
          coordinates: [
            [179.999, -16.5],
            [-179.999, -16.5],
          ],
        },
      },
    };
    const nearby = feed({
      location: { geometry: { type: "Point", coordinates: [-179.9995, -16.5] } },
    });
    expect(situationsAgree(crowdRegistry, across, nearby)).toBe(true);
  });

  it("anchors a report drawn as an area on the mean of its corners, each counted once", () => {
    const area = {
      ...crowdAccident,
      location: {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [8.4, 49.0],
              [8.43, 49.0],
              [8.4, 49.03],
              [8.4, 49.0],
            ],
          ],
        },
      },
    };
    // About 200 m from the corners' mean (8.41, 49.01), over 500 m from the
    // mean with the closing corner counted twice.
    const nearMean = feed({
      location: { geometry: { type: "Point", coordinates: [8.4115, 49.0115] } },
    });
    expect(situationsAgree(crowdRegistry, area, nearMean)).toBe(true);
  });

  it("uses the kind's match distance", () => {
    const queue = { ...crowdAccident, kind: "congestion", type: "congestion" };
    const away = { location: { geometry: { type: "Point", coordinates: [8.4, 49.004] } } };
    expect(
      situationsAgree(
        crowdRegistry,
        queue,
        feed({ ...away, kind: "congestion", type: "congestion" }),
      ),
    ).toBe(true);
    expect(situationsAgree(crowdRegistry, crowdAccident, feed(away))).toBe(false);
  });
});

describe("observations agree", () => {
  const price = (amount: string, at = "2026-10-01T11:58:00Z") => ({
    property: "fuel.price",
    result: { type: "money" as const, amount, currency: "EUR", per: "L" },
    phenomenonTime: { instant: at },
  });

  it("within the property's tolerance, in the same currency and sale unit", () => {
    expect(
      resultsAgree(crowdRegistry, "fuel.price", price("1.479").result, price("1.489").result),
    ).toBe(true);
    expect(
      resultsAgree(crowdRegistry, "fuel.price", price("1.479").result, price("1.490").result),
    ).toBe(false);
    expect(
      resultsAgree(crowdRegistry, "fuel.price", price("1.479").result, {
        ...price("1.479").result,
        currency: "CHF",
      }),
    ).toBe(false);
    const status = (value: string) => ({ type: "category" as const, value, vocabulary: "los" });
    expect(
      resultsAgree(crowdRegistry, "charging.evse_status", status("blocked"), status("blocked")),
    ).toBe(true);
    expect(
      resultsAgree(crowdRegistry, "charging.evse_status", status("blocked"), status("slow")),
    ).toBe(false);
  });

  it("confirm a report with the reading in force when it was made, however old", () => {
    expect(
      observationConfirms(crowdRegistry, price("1.479"), price("1.48", "2026-09-30T06:00:00Z")),
    ).toBe(true);
    expect(
      observationConfirms(crowdRegistry, price("1.479"), {
        ...price("1.48", "2026-09-30T06:00:00Z"),
        validUntil: "2026-10-01T11:00:00Z",
      }),
    ).toBe(false);
    expect(
      observationConfirms(crowdRegistry, price("1.479"), {
        ...price("1.48"),
        phenomenonTime: { start: "2026-09-30T00:00:00Z", end: "2026-10-01T11:00:00Z" },
      }),
    ).toBe(false);
  });

  it("confirm a report with a reading that arrives within the report's lifetime", () => {
    expect(
      observationConfirms(crowdRegistry, price("1.479"), price("1.48", "2026-10-01T14:58:00Z")),
    ).toBe(true);
    expect(
      observationConfirms(crowdRegistry, price("1.479"), price("1.48", "2026-10-01T14:58:01Z")),
    ).toBe(false);
  });

  it("confirm a report with a reading that arrives while confirmations keep it alive", () => {
    const confirmed = { ...price("1.479"), expiresAt: "2026-10-01T18:00:00Z" };
    expect(
      observationConfirms(crowdRegistry, confirmed, price("1.48", "2026-10-01T17:00:00Z")),
    ).toBe(true);
    expect(
      observationConfirms(crowdRegistry, confirmed, price("1.48", "2026-10-01T18:00:01Z")),
    ).toBe(false);
  });

  it("never confirm across qualifiers, properties or a disagreeing value", () => {
    expect(
      observationConfirms(crowdRegistry, price("1.479"), {
        ...price("1.479"),
        qualifiers: { product: "e5" },
      }),
    ).toBe(false);
    expect(observationConfirms(crowdRegistry, price("1.479"), price("1.60"))).toBe(false);
    expect(
      observationConfirms(
        crowdRegistry,
        { ...price("1.479"), property: "traffic.speed" },
        { ...price("1.479"), property: "traffic.speed" },
      ),
    ).toBe(false);
  });
});
