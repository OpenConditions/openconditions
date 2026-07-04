import type { Observation } from "@openconditions/core";
import { describe, expect, it } from "vitest";
import { enrichEventSeverity } from "../severity-derive.js";

const ev = (over: Record<string, unknown>): Observation =>
  ({
    kind: "event",
    domain: "roads",
    severity: "unknown",
    severitySource: "declared",
    type: "other",
    ...over,
  }) as unknown as Observation;

describe("enrichEventSeverity", () => {
  it("derives from impact (roadState closed → high) in preference to the type map", () => {
    // roadworks would map to low, but a full closure is high — impact wins.
    const [o] = enrichEventSeverity([ev({ type: "roadworks", roadState: "closed" })]);
    expect(o).toMatchObject({ severity: "high", severitySource: "derived" });
  });

  it("falls back to the type map when there is no impact signal", () => {
    const [o] = enrichEventSeverity([ev({ type: "roadworks" })]);
    expect(o).toMatchObject({ severity: "low", severitySource: "derived" });
  });

  it("maps a full closure to high and a lane closure to medium", () => {
    const [a, b] = enrichEventSeverity([
      ev({ type: "road_closure" }),
      ev({ type: "lane_closure" }),
    ]);
    expect(a).toMatchObject({ severity: "high", severitySource: "derived" });
    expect(b).toMatchObject({ severity: "medium", severitySource: "derived" });
  });

  it("leaves a declared severity untouched", () => {
    const input = ev({ type: "roadworks", severity: "critical", severitySource: "declared" });
    const [o] = enrichEventSeverity([input]);
    expect(o).toBe(input);
    expect(o).toMatchObject({ severity: "critical", severitySource: "declared" });
  });

  it("leaves an ambiguous/unmapped type unknown rather than fabricating one", () => {
    const input = ev({ type: "authority" });
    const [o] = enrichEventSeverity([input]);
    expect(o).toBe(input);
    expect(o).toMatchObject({ severity: "unknown" });
  });

  it("passes flows/measurements through untouched", () => {
    const flow = { kind: "measurement", metric: "flow" } as unknown as Observation;
    const [o] = enrichEventSeverity([flow]);
    expect(o).toBe(flow);
  });
});
