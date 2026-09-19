import { describe, expect, it } from "vitest";
import { buildMeasuredSiteFlow, localTimestamp, makeOrigin, reclassifyFlow } from "../flow.js";
import type { SourceDescriptor } from "../types.js";

const src: SourceDescriptor = {
  id: "nl-ndw-flow",
  attribution: "NDW",
  country: "NL",
  license: "CC0-1.0",
};
const NOW = "2026-09-18T10:00:00.000Z";
const geom = { type: "Point" as const, coordinates: [4.9, 52.37] as [number, number] };

describe("flow site hints", () => {
  it("names the site and says whether the level of service was computed", () => {
    const stated = buildMeasuredSiteFlow(
      { siteId: "S1", measuredAt: NOW, geom, speedKph: 30, trafficStatus: "queuing" },
      src,
      makeOrigin(src),
      NOW,
    )!;
    expect(stated.flow.site).toEqual({ id: "S1" });
    const computed = buildMeasuredSiteFlow(
      { siteId: "S2", measuredAt: NOW, geom, speedKph: 30, freeFlowKph: 100 },
      src,
      makeOrigin(src),
      NOW,
    )!;
    expect(computed.flow.site).toEqual({ id: "S2", losDerived: true });
  });

  it("marks a level of service a baseline supplies as computed", () => {
    const base = buildMeasuredSiteFlow(
      { siteId: "S3", measuredAt: NOW, geom, speedKph: 30 },
      src,
      makeOrigin(src),
      NOW,
    )!.flow;
    expect(base.site).toEqual({ id: "S3" });
    expect(reclassifyFlow(base, 100, "derived", src).flow.site).toEqual({
      id: "S3",
      losDerived: true,
    });
  });

  it("points a derived congestion situation at its site and owns up to its headline", () => {
    const { event } = buildMeasuredSiteFlow(
      { siteId: "S4", measuredAt: NOW, geom, speedKph: 5, trafficStatus: "stationary" },
      src,
      makeOrigin(src),
      NOW,
    )!;
    expect(event?.situation).toEqual({ headlineFromSource: false, derivedFromSite: "S4" });
  });

  it("reads a zoneless local timestamp in the publisher's zone", () => {
    expect(localTimestamp("2026-03-04T14:30:00.000", "America/New_York")).toBe(
      "2026-03-04T19:30:00.000Z",
    );
    expect(localTimestamp("2026-07-29T13:15:57", "Europe/Madrid")).toBe("2026-07-29T11:15:57.000Z");
    expect(localTimestamp("01:55:30", "Asia/Hong_Kong")).toBeUndefined();
  });
});
