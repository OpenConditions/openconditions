import type { Observation } from "@openconditions/core";
import { describe, expect, it } from "vitest";
import { enrichEventSeverity } from "../severity-derive.js";
import type { RoadEvent } from "../model.js";

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

describe("enrichEventSeverity — delay floor", () => {
  it("raises a long-delay event to high", () => {
    const [out] = enrichEventSeverity([
      ev({ severity: "medium", delaySeconds: 1500 }),
    ]) as RoadEvent[];
    expect(out.severity).toBe("high");
    expect(out.severitySource).toBe("derived");
  });
  it("never sets critical from delay alone", () => {
    const [out] = enrichEventSeverity([
      ev({ severity: "medium", delaySeconds: 100000 }),
    ]) as RoadEvent[];
    expect(out.severity).toBe("high");
  });
  it("does not downgrade an already-higher severity", () => {
    const [out] = enrichEventSeverity([
      ev({ severity: "critical", delaySeconds: 1500 }),
    ]) as RoadEvent[];
    expect(out.severity).toBe("critical");
  });
  it("ignores short/absent delays (existing derivation wins)", () => {
    const [out] = enrichEventSeverity([ev({ severity: "low", delaySeconds: 120 })]) as RoadEvent[];
    expect(out.severity).toBe("low");
  });
  it("returns the same object when nothing changes", () => {
    const input = ev({ severity: "high", delaySeconds: 120 });
    expect(enrichEventSeverity([input])[0]).toBe(input);
  });
  it("floors an unknown-severity, unmapped-type event with a large delay to high", () => {
    // A type with no TYPE_SEVERITY mapping (e.g. "other") leaves derivation at
    // "unknown"; the delay floor must still raise it.
    const [out] = enrichEventSeverity([
      ev({ type: "other", severity: "unknown", delaySeconds: 1500 }),
    ]) as RoadEvent[];
    expect(out.severity).toBe("high");
  });
});
