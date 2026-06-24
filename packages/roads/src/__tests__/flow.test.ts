import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDigitrafficFlow, parseDatexMeasuredData } from "../flow.js";
import { parseDigitraffic } from "../digitraffic.js";
import { parseDatexSituations } from "../datex.js";

const DT_FLOW_FIXTURE = join(import.meta.dirname, "fixtures/digitraffic-flow/flow.json");
const DATEX_FLOW_FIXTURE = join(
  import.meta.dirname,
  "fixtures/datex-measured-data/measured_data.xml"
);
const DT_EVENTS_FIXTURE = join(import.meta.dirname, "fixtures/digitraffic/messages.json");
const NDW_FIXTURE = join(import.meta.dirname, "fixtures/ndw/actueel_beeld.xml");

const DT_SOURCE = {
  id: "digitraffic-fi",
  attribution: "Fintraffic / digitraffic.fi",
  country: "FI",
  license: "CC-BY-4.0",
  licenseUrl: "https://www.digitraffic.fi/en/road-traffic/#license",
} as const;

const NDW_SOURCE = {
  id: "ndw",
  attribution: "NDW / Rijkswaterstaat",
  country: "NL",
  license: "CC0-1.0",
  licenseUrl: "https://www.ndw.nu",
} as const;

describe("parseDigitrafficFlow — fixture", () => {
  it("parses at least one RoadFlow measurement", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    expect(flows.length).toBeGreaterThan(0);
  });

  it("emits kind:'measurement' and metric:'flow' on every flow", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    expect(flows.every((f) => f.kind === "measurement")).toBe(true);
    expect(flows.every((f) => f.metric === "flow")).toBe(true);
  });

  it("emits domain:'roads' on every flow", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    expect(flows.every((f) => f.domain === "roads")).toBe(true);
  });

  it("emits aggregation:'live' on every flow", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    expect(flows.every((f) => f.aggregation === "live")).toBe(true);
  });

  it("maps congestionLevel FREE_FLOW to los:'free_flow'", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    const freeFlow = flows.find((f) => f.id.includes("DT_FLOW_FREE"));
    expect(freeFlow).toBeDefined();
    expect(freeFlow!.los).toBe("free_flow");
  });

  it("maps congestionLevel HEAVY to los:'heavy'", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    const heavy = flows.find((f) => f.id.includes("DT_FLOW_HEAVY"));
    expect(heavy).toBeDefined();
    expect(heavy!.los).toBe("heavy");
  });

  it("maps congestionLevel STATIONARY to los:'stationary'", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    const stationary = flows.find((f) => f.id.includes("DT_FLOW_STATIONARY"));
    expect(stationary).toBeDefined();
    expect(stationary!.los).toBe("stationary");
  });

  it("sets speedKph from averageSpeed", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    const freeFlow = flows.find((f) => f.id.includes("DT_FLOW_FREE"));
    expect(freeFlow!.speedKph).toBeCloseTo(95.2);
  });

  it("sets freeFlowKph from freeFlowSpeed when present", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    const freeFlow = flows.find((f) => f.id.includes("DT_FLOW_FREE"));
    expect(freeFlow!.freeFlowKph).toBeCloseTo(100.0);
  });

  it("computes speedRatio when both averageSpeed and freeFlowSpeed are present", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    const freeFlow = flows.find((f) => f.id.includes("DT_FLOW_FREE"));
    expect(freeFlow!.speedRatio).toBeCloseTo(95.2 / 100.0, 2);
  });

  it("carries delaySeconds when provided", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    const stationary = flows.find((f) => f.id.includes("DT_FLOW_STATIONARY"));
    expect(stationary!.delaySeconds).toBe(420);
  });

  it("carries jamFactor when provided", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    const stationary = flows.find((f) => f.id.includes("DT_FLOW_STATIONARY"));
    expect(stationary!.jamFactor).toBeCloseTo(9.8);
  });

  it("emits a LineString geometry on every flow", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    for (const f of flows) {
      expect(f.geometry.type).toBe("LineString");
    }
  });

  it("skips features with null geometry", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    const noGeo = flows.find((f) => f.id.includes("DT_FLOW_NOGEO"));
    expect(noGeo).toBeUndefined();
  });

  it("prefixes each flow id with source id", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    expect(flows.every((f) => f.id.startsWith("digitraffic-fi:"))).toBe(true);
  });

  it("carries license from source descriptor via origin", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows } = parseDigitrafficFlow(json, DT_SOURCE);
    for (const f of flows) {
      expect(f.origin.kind).toBe("feed");
      if (f.origin.kind === "feed") {
        expect(f.origin.attribution.license).toBe("CC-BY-4.0");
      }
    }
  });

  it("never throws on empty features array", () => {
    const input = JSON.stringify({ type: "FeatureCollection", features: [] });
    expect(() => parseDigitrafficFlow(input, DT_SOURCE)).not.toThrow();
    expect(parseDigitrafficFlow(input, DT_SOURCE).flows).toEqual([]);
  });

  it("never throws on invalid JSON", () => {
    expect(() => parseDigitrafficFlow("not-json", DT_SOURCE)).not.toThrow();
    expect(parseDigitrafficFlow("not-json", DT_SOURCE).flows).toEqual([]);
  });
});

describe("parseDigitrafficFlow — derived congestion events", () => {
  it("emits a derived congestion RoadEvent for los:'stationary'", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { events } = parseDigitrafficFlow(json, DT_SOURCE);
    const congestion = events.find((e) => e.id.includes("DT_FLOW_STATIONARY"));
    expect(congestion).toBeDefined();
    expect(congestion!.type).toBe("congestion");
    expect(congestion!.kind).toBe("event");
  });

  it("does NOT emit a derived congestion event for los:'free_flow'", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { events } = parseDigitrafficFlow(json, DT_SOURCE);
    const freeFlowCongestion = events.find((e) => e.id.includes("DT_FLOW_FREE"));
    expect(freeFlowCongestion).toBeUndefined();
  });

  it("does NOT emit a derived congestion event for los:'heavy'", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { events } = parseDigitrafficFlow(json, DT_SOURCE);
    const heavyCongestion = events.find((e) => e.id.includes("DT_FLOW_HEAVY"));
    expect(heavyCongestion).toBeUndefined();
  });

  it("derived congestion event carries severity:'critical' for los:'stationary'", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { events } = parseDigitrafficFlow(json, DT_SOURCE);
    const congestion = events.find((e) => e.id.includes("DT_FLOW_STATIONARY"));
    expect(congestion!.severity).toBe("critical");
  });

  it("derived congestion event has category:'conditions'", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { events } = parseDigitrafficFlow(json, DT_SOURCE);
    const congestion = events.find((e) => e.id.includes("DT_FLOW_STATIONARY"));
    expect(congestion!.category).toBe("conditions");
  });

  it("derived congestion event shares the same LineString geometry as the flow", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows, events } = parseDigitrafficFlow(json, DT_SOURCE);
    const flow = flows.find((f) => f.id.includes("DT_FLOW_STATIONARY"))!;
    const congestion = events.find((e) => e.id.includes("DT_FLOW_STATIONARY"))!;
    expect(congestion.geometry).toEqual(flow.geometry);
  });

  it("emits a derived congestion RoadEvent with severity:'high' for los:'queuing'", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { flows, events } = parseDigitrafficFlow(json, DT_SOURCE);
    const flow = flows.find((f) => f.id.includes("DT_FLOW_QUEUING"));
    expect(flow).toBeDefined();
    expect(flow!.los).toBe("queuing");
    const congestion = events.find((e) => e.id.includes("DT_FLOW_QUEUING"));
    expect(congestion).toBeDefined();
    expect(congestion!.type).toBe("congestion");
    expect(congestion!.severity).toBe("high");
  });

  it("does NOT emit a derived congestion event for los:'free_flow' or los:'heavy' (negative guard)", () => {
    const json = readFileSync(DT_FLOW_FIXTURE, "utf8");
    const { events } = parseDigitrafficFlow(json, DT_SOURCE);
    expect(events.find((e) => e.id.includes("DT_FLOW_FREE"))).toBeUndefined();
    expect(events.find((e) => e.id.includes("DT_FLOW_HEAVY"))).toBeUndefined();
  });
});

describe("parseDatexMeasuredData — fixture", () => {
  it("parses at least one RoadFlow measurement", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE);
    expect(flows.length).toBeGreaterThan(0);
  });

  it("emits kind:'measurement' and metric:'flow' on every flow", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE);
    expect(flows.every((f) => f.kind === "measurement")).toBe(true);
    expect(flows.every((f) => f.metric === "flow")).toBe(true);
  });

  it("emits domain:'roads' on every flow", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE);
    expect(flows.every((f) => f.domain === "roads")).toBe(true);
  });

  it("sets speedKph from averageVehicleSpeed", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE);
    const withSpeed = flows.find((f) => f.speedKph != null);
    expect(withSpeed).toBeDefined();
    expect(withSpeed!.speedKph).toBeGreaterThan(0);
  });

  it("maps trafficStatus:'heavy' to los:'heavy'", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE);
    const heavy = flows.find((f) => f.id.includes("NL-MS-002"));
    expect(heavy).toBeDefined();
    expect(heavy!.los).toBe("heavy");
  });

  it("maps trafficStatus:'stationary' to los:'stationary'", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE);
    const stationary = flows.find((f) => f.id.includes("NL-MS-003"));
    expect(stationary).toBeDefined();
    expect(stationary!.los).toBe("stationary");
  });

  it("emits a LineString geometry on every flow (skips non-LineString geometry)", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE);
    for (const f of flows) {
      expect(f.geometry.type).toBe("LineString");
    }
  });

  it("emits a derived congestion event for los:'stationary'", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE);
    const { events } = parseDatexMeasuredData(xml, NDW_SOURCE);
    const congestion = events.find((e) => e.id.includes("NL-MS-003"));
    expect(congestion).toBeDefined();
    expect(congestion!.type).toBe("congestion");
  });

  it("carries license from source descriptor", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE);
    for (const f of flows) {
      expect(f.origin.kind).toBe("feed");
      if (f.origin.kind === "feed") {
        expect(f.origin.attribution.license).toBe("CC0-1.0");
      }
    }
  });

  it("never throws on empty XML", () => {
    expect(() =>
      parseDatexMeasuredData(Buffer.from("<D2LogicalModel/>"), NDW_SOURCE)
    ).not.toThrow();
    expect(parseDatexMeasuredData(Buffer.from("<D2LogicalModel/>"), NDW_SOURCE).flows).toEqual([]);
  });
});

describe("regression — existing event parsers untouched", () => {
  it("parseDigitraffic still produces RoadEvents from the events fixture", () => {
    const json = readFileSync(DT_EVENTS_FIXTURE, "utf8");
    const events = parseDigitraffic(json, DT_SOURCE);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === "event")).toBe(true);
    expect(events.every((e) => e.domain === "roads")).toBe(true);
  });

  it("parseDatexSituations still produces RoadEvents from the NDW fixture", () => {
    const xml = readFileSync(NDW_FIXTURE);
    const events = parseDatexSituations(xml, NDW_SOURCE);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === "event")).toBe(true);
    expect(events.every((e) => e.domain === "roads")).toBe(true);
  });
});
