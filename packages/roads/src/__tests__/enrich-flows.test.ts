import { describe, expect, it } from "vitest";
import { enrichFlowsWithBaseline } from "../flow.js";
import type { Observation } from "@openconditions/core";
import type { BaselineMethod } from "../model.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "src",
  attribution: "T",
  country: "FI",
  license: "CC-BY-4.0",
} as SourceDescriptor;

function flow(id: string, extra: Record<string, unknown>): Observation {
  return {
    id,
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
    ...extra,
  } as unknown as Observation;
}

describe("enrichFlowsWithBaseline", () => {
  it("enriches only speed-bearing flows lacking a baseline, stamping method + appending events", () => {
    const map = new Map<string, { kph: number; method: BaselineMethod }>([
      ["src:slow", { kph: 100, method: "derived" }],
      ["src:fast", { kph: 100, method: "osm_maxspeed" }],
    ]);
    const out = enrichFlowsWithBaseline(
      [
        flow("src:slow", { speedKph: 30 }),
        flow("src:fast", { speedKph: 95 }),
        flow("src:none", {}),
      ],
      map,
      src
    );
    const byId = new Map(out.map((o) => [o.id, o]));
    expect((byId.get("src:slow") as any).los).toBe("queuing");
    expect((byId.get("src:slow") as any).freeFlowSource).toBe("derived");
    expect((byId.get("src:fast") as any).los).toBe("free_flow");
    expect((byId.get("src:fast") as any).freeFlowSource).toBe("osm_maxspeed");
    expect((byId.get("src:none") as any).los).toBe("unknown");
    expect(
      out.some((o) => o.id === "src:slow:congestion" && (o as any).type === "congestion")
    ).toBe(true);
  });
  it("passes non-flow observations through untouched", () => {
    const event = {
      ...flow("src:evt", {}),
      kind: "event",
      type: "accident",
    } as unknown as Observation;
    const out = enrichFlowsWithBaseline([event], new Map(), src);
    expect(out).toEqual([event]);
  });
  it("passes a flow through untouched when it already has a freeFlowKph, even with a matching baseline entry", () => {
    const map = new Map<string, { kph: number; method: BaselineMethod }>([
      ["src:has-ff", { kph: 100, method: "derived" }],
    ]);
    const existing = flow("src:has-ff", { speedKph: 30, freeFlowKph: 90 });
    const out = enrichFlowsWithBaseline([existing], map, src);
    expect(out).toEqual([existing]);
    expect(out.some((o) => (o as any).type === "congestion")).toBe(false);
  });
});
