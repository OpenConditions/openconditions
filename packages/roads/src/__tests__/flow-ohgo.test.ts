import { describe, expect, it } from "vitest";
import { fixture, flowFeed, flows, readings, site } from "./flow-fixtures.js";

const FEED = "us-oh-ohgo";
const feed = flowFeed(FEED);

describe("OHGO travel delays", () => {
  it("classifies the speed against the inline NormalAvgSpeed as a native baseline", () => {
    const out = flows(feed, fixture("flow/ohgo.json"));
    const [slow] = readings(out, FEED, "d1", "traffic.speed");
    expect((slow!["result"] as { value: number }).value).toBeCloseTo(20 * 1.609344, 2);
    expect(slow!["baseline"]).toMatchObject({ source: "native", los: "queuing" }); // 20/65 ≈ 0.31
    expect((slow!["baseline"] as { freeFlow: { value: number } }).freeFlow.value).toBeCloseTo(
      65 * 1.609344,
      2,
    );
    const [ok] = readings(out, FEED, "d2", "traffic.speed");
    expect(ok!["baseline"]).toMatchObject({ los: "free_flow" }); // 62/65 ≈ 0.95
  });

  it("derives a congestion situation in the site's direction", () => {
    const out = flows(feed, fixture("flow/ohgo.json"));
    expect(out.situations.map((s) => s["id"])).toEqual([`oc:situation:${FEED}:d1:congestion`]);
    const direction = { value: "unknown", basis: "compass", compass: "E", text: "EB" };
    expect((out.situations[0]!["location"] as { direction: unknown }).direction).toEqual(direction);
    expect((site(out, FEED, "d1")!["location"] as { direction: unknown }).direction).toEqual(
      direction,
    );
  });

  it("drafts nothing for malformed input", () => {
    expect(flows(feed, "x")).toEqual({ features: [], observations: [], situations: [] });
  });
});
