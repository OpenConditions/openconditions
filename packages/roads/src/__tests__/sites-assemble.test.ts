import { describe, expect, it } from "vitest";
import { localTimestamp } from "../flow.js";
import type { FlowReading } from "../flow-reading.js";
import { flowOutput, zonedInstant } from "../sites/assemble.js";
import type { SourceDescriptor } from "../types.js";

const source: SourceDescriptor = {
  id: "fi-digitraffic-flow",
  attribution: "Fintraffic",
  country: "FI",
  license: "CC-BY-4.0",
};
const ctx = { now: "2026-09-18T10:00:30.000Z", cadenceSec: 60 };
const AT = "2026-09-18T09:59:00Z";

function reading(overrides: Partial<FlowReading>): FlowReading {
  return {
    site: "L1",
    geometry: {
      type: "LineString",
      coordinates: [
        [24.9, 60.2],
        [24.91, 60.21],
      ],
    },
    at: AT,
    los: "unknown",
    ...overrides,
  };
}

const assemble = (readings: FlowReading[], format = "digitraffic-traffic-measurement") =>
  flowOutput(readings, { source, format, ctx });

describe("flowOutput", () => {
  it("lets derived congestion lapse unless a later poll derives it again", () => {
    const { situations } = assemble([reading({ speedKph: 5, los: "stationary" })]);
    expect(situations).toHaveLength(1);
    expect(situations[0]!["freshness"]).toMatchObject({
      fetchedAt: "2026-09-18T10:00:30.000Z",
      expiresAt: "2026-09-18T10:15:30.000Z",
    });
  });

  it("makes one site per source site and one reading per property", () => {
    const { features, observations } = assemble([reading({ speedKph: 87, los: "free_flow" })]);
    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      id: "oc:feature:fi-digitraffic-flow:L1",
      kind: "measurement_site",
      lifecycle: "operational",
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
    const { observations } = assemble([
      reading({
        speedKph: 40,
        freeFlowKph: 100,
        freeFlowSource: "derived",
        speedRatio: 0.4,
        los: "queuing",
        losDerived: true,
      }),
    ]);
    expect(observations.map((o) => o["property"])).toEqual(["traffic.speed"]);
    expect(observations[0]!["baseline"]).toEqual({
      freeFlow: { value: 100, unit: "km/h" },
      source: "derived",
      ratio: 0.4,
      los: "queuing",
    });
  });

  it("joins the lines of one site and collapses their identical readings", () => {
    const second = reading({
      line: "L1:1",
      geometry: {
        type: "LineString",
        coordinates: [
          [24.92, 60.22],
          [24.93, 60.23],
        ],
      },
      speedKph: 70,
    });
    const { features, observations } = assemble([reading({ line: "L1:0", speedKph: 70 }), second]);
    expect(features).toHaveLength(1);
    expect((features[0]!["location"] as { geometry: { type: string } }).geometry.type).toBe(
      "MultiLineString",
    );
    expect(observations).toHaveLength(1);
  });

  it("gives channels their own components and series", () => {
    const { features, observations } = assemble(
      [
        reading({
          site: "S",
          geometry: { type: "Point", coordinates: [24.9, 60.2] },
          speedKph: 90,
          channels: [
            { key: "1", property: "traffic.speed", value: 95, lane: 1 },
            { key: "2", property: "traffic.speed", value: 85, lane: 2, vehicleClass: "any" },
          ],
        }),
      ],
      "datex2-measured",
    );
    expect(features[0]!["components"]).toEqual([
      {
        key: "1",
        kind: "sensor_channel",
        details: {
          kind: "sensor_channel",
          v: 1,
          index: 1,
          lane: { index: 1 },
          property: "traffic.speed",
        },
      },
      {
        key: "2",
        kind: "sensor_channel",
        details: {
          kind: "sensor_channel",
          v: 1,
          index: 2,
          lane: { index: 2 },
          vehicleClass: "any",
          property: "traffic.speed",
        },
      },
    ]);
    expect(
      observations.map((o) => (o["subject"] as { componentKey?: string }).componentKey),
    ).toEqual([undefined, "1", "2"]);
  });

  it("refuses a format with no registered flow format", () => {
    expect(() => assemble([reading({ speedKph: 1 })], "nope")).toThrow(/not registered/);
  });

  it("dates a reading without a zone-bearing time by the poll, floored to the cadence", () => {
    const { observations } = assemble([reading({ speedKph: 50, at: "2026-09-18T01:55:30" })]);
    expect(observations[0]!["phenomenonTime"]).toEqual({ instant: "2026-09-18T10:00:00.000Z" });
  });

  it("drops a reading with nothing to say", () => {
    expect(assemble([reading({})])).toEqual({ features: [], observations: [], situations: [] });
  });
});

describe("reading times", () => {
  it("accepts only instants that name their zone", () => {
    expect(zonedInstant("2026-03-04T14:30:00Z")).toBe("2026-03-04T14:30:00.000Z");
    expect(zonedInstant("2026-07-27T02:02:30.880+02:00")).toBe("2026-07-27T00:02:30.880Z");
    expect(zonedInstant("2026-03-04T14:30:00")).toBeUndefined();
    expect(zonedInstant("01:55:30")).toBeUndefined();
  });

  it("reads a zoneless local timestamp in the publisher's zone", () => {
    expect(localTimestamp("2026-03-04T14:30:00.000", "America/New_York")).toBe(
      "2026-03-04T19:30:00.000Z",
    );
    expect(localTimestamp("2026-07-29T13:15:57", "Europe/Madrid")).toBe("2026-07-29T11:15:57.000Z");
    expect(localTimestamp("01:55:30", "Asia/Hong_Kong")).toBeUndefined();
  });
});
