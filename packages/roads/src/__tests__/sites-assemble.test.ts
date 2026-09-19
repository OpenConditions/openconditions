import { describe, expect, it } from "vitest";
import type { RoadFlow } from "../model.js";
import { measurementDrafts } from "../sites/assemble.js";
import type { SourceDescriptor } from "../types.js";

const source: SourceDescriptor = {
  id: "fi-digitraffic-flow",
  attribution: "Fintraffic",
  country: "FI",
  license: "CC-BY-4.0",
};
const AT = "2026-09-18T09:59:00Z";

function flow(overrides: Partial<RoadFlow>): RoadFlow {
  return {
    id: "fi-digitraffic-flow:L1",
    source: source.id,
    sourceFormat: "digitraffic",
    domain: "roads",
    kind: "measurement",
    metric: "flow",
    aggregation: "live",
    status: "active",
    geometry: {
      type: "LineString",
      coordinates: [
        [24.9, 60.2],
        [24.91, 60.21],
      ],
    },
    los: "unknown",
    site: { id: "L1" },
    origin: { kind: "feed", attribution: { provider: "Fintraffic", license: "CC-BY-4.0" } },
    dataUpdatedAt: AT,
    fetchedAt: "2026-09-18T10:00:00Z",
    isStale: false,
    ...overrides,
  } as RoadFlow;
}

describe("measurementDrafts", () => {
  it("makes one site per source site and one reading per property", () => {
    const { features, observations } = measurementDrafts(
      [flow({ speedKph: 87, los: "free_flow" })],
      { source },
    );
    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      id: "oc:feature:fi-digitraffic-flow:L1",
      kind: "measurement_site",
      details: { measuredProperties: ["traffic.speed", "traffic.los"] },
    });
    expect(observations.map((o) => o["property"])).toEqual(["traffic.speed", "traffic.los"]);
    expect(observations[0]).toMatchObject({
      subject: { kind: "feature", featureId: "oc:feature:fi-digitraffic-flow:L1" },
      result: { type: "quantity", value: 87, unit: "km/h" },
      phenomenonTime: { instant: "2026-09-18T09:59:00.000Z" },
      aggregation: "mean",
    });
  });

  it("keeps a level of service computed from speed on the baseline, not as a reading", () => {
    const { observations } = measurementDrafts(
      [
        flow({
          speedKph: 40,
          freeFlowKph: 100,
          freeFlowSource: "derived",
          speedRatio: 0.4,
          los: "queuing",
          site: { id: "L1", losDerived: true },
        }),
      ],
      { source },
    );
    expect(observations.map((o) => o["property"])).toEqual(["traffic.speed"]);
    expect(observations[0]!["baseline"]).toEqual({
      freeFlow: { value: 100, unit: "km/h" },
      source: "derived",
      ratio: 0.4,
      los: "queuing",
    });
  });

  it("joins the lines of one site and collapses their identical readings", () => {
    const second = flow({
      id: "fi-digitraffic-flow:L1:1",
      geometry: {
        type: "LineString",
        coordinates: [
          [25, 60.3],
          [25.1, 60.31],
        ],
      },
      speedKph: 70,
    });
    const { features, observations } = measurementDrafts(
      [flow({ id: "fi-digitraffic-flow:L1:0", speedKph: 70 }), second],
      { source },
    );
    expect(features).toHaveLength(1);
    expect((features[0]!["location"] as { geometry: { type: string } }).geometry.type).toBe(
      "MultiLineString",
    );
    expect(observations).toHaveLength(1);
  });

  it("gives separately reported directions their own channel and series", () => {
    const station = (channel: string, speedKph: number) =>
      flow({
        id: `fi-fintraffic:23001-${channel}`,
        sourceFormat: "fintraffic-tms",
        geometry: { type: "Point", coordinates: [24.9, 60.2] },
        speedKph,
        site: { id: "23001", channel },
      });
    const { features, observations } = measurementDrafts([station("1", 95), station("2", 88)], {
      source,
    });
    expect(features[0]!["components"]).toEqual([
      expect.objectContaining({ key: "1", kind: "sensor_channel" }),
      expect.objectContaining({ key: "2", kind: "sensor_channel" }),
    ]);
    expect(
      observations.map((o) => (o["subject"] as { componentKey: string }).componentKey),
    ).toEqual(["1", "2"]);
  });

  it("refuses flows a parser did not hint or whose format is not registered", () => {
    expect(() => measurementDrafts([flow({ site: undefined })], { source })).toThrow(
      /no site hints/,
    );
    expect(() => measurementDrafts([flow({ sourceFormat: "nope" })], { source })).toThrow(
      /not registered/,
    );
  });

  it("skips a reading whose time is not an instant", () => {
    const { features, observations } = measurementDrafts(
      [flow({ speedKph: 50, dataUpdatedAt: "01:55:30" })],
      { source },
    );
    expect(features).toHaveLength(1);
    expect(observations).toEqual([]);
  });
});
