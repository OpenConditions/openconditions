import { describe, expect, it } from "vitest";
import { reclassifyFlow } from "../flow.js";
import type { RoadFlow } from "../model.js";
import type { SourceDescriptor } from "../types.js";

const src: SourceDescriptor = {
  id: "src",
  attribution: "T",
  country: "FI",
  license: "CC-BY-4.0",
} as SourceDescriptor;

function base(overrides: Partial<RoadFlow>): RoadFlow {
  return {
    id: "src:1",
    source: "src",
    sourceFormat: "fintraffic-tms-json",
    domain: "roads",
    kind: "measurement",
    metric: "flow",
    aggregation: "live",
    status: "active",
    geometry: { type: "Point", coordinates: [24.9, 60.2] },
    los: "unknown",
    origin: { kind: "feed", attribution: { provider: "T", license: "CC-BY-4.0" } },
    dataUpdatedAt: "2026-03-04T14:30:00Z",
    fetchedAt: "2026-03-04T14:31:00Z",
    isStale: false,
    ...overrides,
  } as RoadFlow;
}

describe("reclassifyFlow", () => {
  it("classifies free_flow at ratio >= 0.85, stamps freeFlowSource, emits no event", () => {
    const { flow, event } = reclassifyFlow(base({ speedKph: 90 }), 100, "native", src);
    expect(flow.los).toBe("free_flow");
    expect(flow.freeFlowKph).toBe(100);
    expect(flow.freeFlowSource).toBe("native");
    expect(flow.speedRatio).toBeCloseTo(0.9);
    expect(flow.level).toBe("free_flow");
    expect(event).toBeUndefined();
  });
  it("classifies queuing and emits a derived congestion event with validFrom + freeFlowSource", () => {
    const input = base({ speedKph: 30 });
    const { flow, event } = reclassifyFlow(input, 100, "derived", src);
    expect(flow.los).toBe("queuing");
    expect(flow.freeFlowSource).toBe("derived");
    expect(event?.type).toBe("congestion");
    expect(event?.id).toBe("src:1:congestion");
    expect(event?.severitySource).toBe("derived");
    // canonicalId buckets on validFrom, so it must carry the measurement instant.
    expect(event?.validFrom).toBe(input.dataUpdatedAt);
    // Baseline provenance is stamped ON the event, not just the flow.
    expect(event?.freeFlowSource).toBe("derived");
  });
  it("stamps the baseline provenance onto the event for an osm_maxspeed baseline", () => {
    const { event } = reclassifyFlow(base({ speedKph: 30 }), 100, "osm_maxspeed", src);
    // An event resting on a coarse osm_maxspeed proxy is now distinguishable at
    // the event row from one backed by history — no join back to the flow.
    expect(event?.freeFlowSource).toBe("osm_maxspeed");
  });
  it("keeps identical los math across methods but a distinguishable freeFlowSource", () => {
    const asDerived = reclassifyFlow(base({ speedKph: 30 }), 100, "derived", src).flow;
    const asOsm = reclassifyFlow(base({ speedKph: 30 }), 100, "osm_maxspeed", src).flow;
    expect(asDerived.los).toBe(asOsm.los);
    expect(asDerived.speedRatio).toBe(asOsm.speedRatio);
    expect(asDerived.freeFlowSource).toBe("derived");
    expect(asOsm.freeFlowSource).toBe("osm_maxspeed");
  });
  it("copies flow.direction onto the derived congestion event when present", () => {
    const { event } = reclassifyFlow(base({ speedKph: 30, direction: "N" }), 100, "derived", src);
    expect(event?.direction).toBe("N");
  });
  it("classifies stationary below 0.15", () => {
    expect(reclassifyFlow(base({ speedKph: 10 }), 100, "derived", src).flow.los).toBe("stationary");
  });
  it("leaves a flow with an already-resolved los untouched", () => {
    const input = base({ speedKph: 30, los: "free_flow" });
    const { flow, event } = reclassifyFlow(input, 100, "derived", src);
    expect(flow.los).toBe("free_flow");
    expect(flow.freeFlowKph).toBeUndefined();
    expect(flow.freeFlowSource).toBeUndefined();
    expect(event).toBeUndefined();
  });
  it("leaves a flow that already carries a freeFlowKph untouched", () => {
    const input = base({ speedKph: 30, freeFlowKph: 40 });
    expect(reclassifyFlow(input, 100, "derived", src).flow.freeFlowKph).toBe(40);
  });
  it("no-ops when speedKph is absent or freeFlowKph <= 0", () => {
    expect(reclassifyFlow(base({}), 100, "derived", src).flow.los).toBe("unknown");
    expect(reclassifyFlow(base({ speedKph: 30 }), 0, "derived", src).flow.los).toBe("unknown");
  });
});
