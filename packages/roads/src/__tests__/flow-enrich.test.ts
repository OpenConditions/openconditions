import { describe, expect, it } from "vitest";
import type { FlowBaseline, FlowOutput } from "../flow-output.js";
import { enrichReadings } from "../parse.js";
import { fixture, flowFeed, flows, readings } from "./flow-fixtures.js";

/**
 * Enrichment applies a stored free-flow baseline to the site speeds a feed
 * left unclassified, derives their level of service on the reading's
 * baseline, and drafts the congestion situations the derived levels call for.
 */
const FEED = "se-trafikverket-flow";
const feed = flowFeed(FEED);
const KEY = `feature:oc:feature:${FEED}:TMS-1`;

/** A poll whose one speed site TMS-1 measured `speed` km/h. */
function poll(speed = 92): FlowOutput {
  const doc = JSON.parse(fixture("flow/trafikverket-flow.json").toString("utf8"));
  doc.RESPONSE.RESULT[0].TrafficFlow[0].AverageVehicleSpeed = speed;
  return flows(feed, JSON.stringify(doc));
}

const enrich = (out: FlowOutput, baseline?: FlowBaseline, key = KEY) =>
  enrichReadings(feed, out, new Map(baseline ? [[key, baseline]] : []));

const speedOf = (out: FlowOutput) => readings(out, FEED, "TMS-1", "traffic.speed")[0]!;

describe("enrichReadings", () => {
  it("classifies free flow at a ratio of 0.85 or more, on the baseline, with no situation", () => {
    const out = enrich(poll(90), { freeFlowKph: 100, method: "native" });
    expect(speedOf(out)["baseline"]).toEqual({
      freeFlow: { value: 100, unit: "km/h" },
      source: "native",
      ratio: 0.9,
      los: "free_flow",
    });
    expect(out.situations).toEqual([]);
  });

  it("drafts a derived congestion situation at queuing, naming the baseline's method", () => {
    const out = enrich(poll(30), { freeFlowKph: 100, method: "derived" });
    expect(speedOf(out)["baseline"]).toMatchObject({ source: "derived", los: "queuing" });
    expect(out.situations).toHaveLength(1);
    expect(out.situations[0]).toMatchObject({
      id: `oc:situation:${FEED}:TMS-1:congestion`,
      kind: "congestion",
      validity: { status: "active", start: "2026-03-04T14:30:00.000Z" },
      details: {
        derivedFrom: { class: "feature", id: `oc:feature:${FEED}:TMS-1` },
        freeFlowSource: "derived",
      },
    });
  });

  it("keeps the same level for every method, telling them apart by source", () => {
    const derived = speedOf(enrich(poll(30), { freeFlowKph: 100, method: "derived" }));
    const osm = speedOf(enrich(poll(30), { freeFlowKph: 100, method: "osm_maxspeed" }));
    expect(derived["baseline"]).toMatchObject({ los: "queuing", source: "derived" });
    expect(osm["baseline"]).toMatchObject({ los: "queuing", source: "osm_maxspeed" });
  });

  it("classifies a genuine standstill as stationary, with a derived situation", () => {
    const out = enrich(poll(0), { freeFlowKph: 100, method: "native" });
    expect(speedOf(out)["baseline"]).toMatchObject({ ratio: 0, los: "stationary" });
    expect(out.situations[0]).toMatchObject({
      kind: "congestion",
      severity: { source: "derived" },
    });
  });

  it("leaves a reading whose level the source states untouched", () => {
    const bonn = flowFeed("de-nw-bonn-flow");
    const out = flows(bonn, fixture("flow/bonn.json"));
    const enriched = enrichReadings(
      bonn,
      out,
      new Map([
        ["feature:oc:feature:de-nw-bonn-flow:143", { freeFlowKph: 200, method: "derived" }],
      ]),
    );
    expect(enriched).toEqual(out);
  });

  it("leaves a reading that carries the feed's own free-flow speed untouched", () => {
    const ohgo = flowFeed("us-oh-ohgo-flow");
    const out = flows(ohgo, fixture("flow/ohgo.json"));
    const enriched = enrichReadings(
      ohgo,
      out,
      new Map([["feature:oc:feature:us-oh-ohgo-flow:d2", { freeFlowKph: 500, method: "derived" }]]),
    );
    expect(enriched).toEqual(out);
  });

  it("leaves the output untouched without a baseline or with a non-positive one", () => {
    const out = poll(30);
    expect(enrich(out)).toEqual(out);
    expect(enrich(out, { freeFlowKph: 0, method: "derived" })).toEqual(out);
  });

  it("does not touch channel readings", () => {
    const ndw = flowFeed("nl-ndw-flow");
    const out = flows(
      ndw,
      fixture("ndw-flow/trafficspeed.xml"),
      new Map([
        [
          "PZH01_MST_0065_00",
          {
            geometry: { type: "Point", coordinates: [4.5, 52] },
            channels: new Map([["8", { property: "traffic.speed" }]]),
          },
        ],
      ]),
    );
    const enriched = enrichReadings(
      ndw,
      out,
      new Map([
        [
          "feature:oc:feature:nl-ndw-flow:PZH01_MST_0065_00#8",
          { freeFlowKph: 100, method: "derived" },
        ],
      ]),
    );
    expect(enriched).toEqual(out);
  });
});
