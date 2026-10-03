import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatexSituations } from "../datex.js";
import { parseDigitraffic } from "../digitraffic.js";
import type { FlowSites } from "../flow-output.js";
import { measuredDataReader } from "../parse.js";
import { parseDatexSiteTable } from "../siteTable.js";
import {
  CTX,
  fixture,
  flowFeed,
  flows,
  readings,
  site,
  siteIds,
  text,
  value,
} from "./flow-fixtures.js";

const DT = "fi-digitraffic-flow";
const dtFeed = flowFeed(DT, "digitraffic");
const digitraffic = (input: string | Buffer = fixture("digitraffic-flow/flow.json")) =>
  flows(dtFeed, input);

const DIR = "fr-dir-flow";
const dirFeed = flowFeed(DIR);
const NDW = "nl-ndw-flow";
const ndwFeed = flowFeed(NDW);
const ndwSites = () => parseDatexSiteTable(fixture("ndw-flow/measurement_site_table.xml"));

const los = (out: ReturnType<typeof flows>, feed: string, id: string) =>
  value(out, feed, id, "traffic.los");

describe("Digitraffic traffic measurements", () => {
  it("drafts one measurement site per segment, with a line geometry", () => {
    const out = digitraffic();
    expect(siteIds(out, DT)).toEqual([
      "DT_FLOW_FREE",
      "DT_FLOW_HEAVY",
      "DT_FLOW_STATIONARY",
      "DT_FLOW_QUEUING",
    ]);
    for (const f of out.features) {
      expect(f["kind"]).toBe("measurement_site");
      expect((f["location"] as { geometry: { type: string } }).geometry.type).toBe("LineString");
    }
  });

  it("states the congestion level as the level of service", () => {
    const out = digitraffic();
    expect(los(out, DT, "DT_FLOW_FREE")).toBe("free_flow");
    expect(los(out, DT, "DT_FLOW_HEAVY")).toBe("heavy");
    expect(los(out, DT, "DT_FLOW_STATIONARY")).toBe("stationary");
  });

  it("keeps the average speed with the feed's own free-flow speed as a native baseline", () => {
    const [speed] = readings(digitraffic(), DT, "DT_FLOW_HEAVY", "traffic.speed");
    expect(speed!["result"]).toEqual({ type: "quantity", value: 52, unit: "km/h" });
    expect(speed!["baseline"]).toEqual({
      freeFlow: { value: 100, unit: "km/h" },
      source: "native",
      ratio: 0.52,
    });
  });

  it("carries the source's licence on every draft", () => {
    for (const d of [...digitraffic().features, ...digitraffic().observations]) {
      expect((d["provenance"] as { attribution: { license: string } }).attribution.license).toBe(
        "CC-BY-4.0",
      );
    }
  });

  it("skips features without line geometry", () => {
    const doc = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null, properties: { id: "X", averageSpeed: 50 } },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [25, 60] },
          properties: { id: "Y", averageSpeed: 50 },
        },
      ],
    };
    expect(digitraffic(JSON.stringify(doc)).features).toEqual([]);
  });

  it("reads an empty features array as a legitimate empty cycle", () => {
    expect(digitraffic('{"type":"FeatureCollection","features":[]}')).toEqual({
      features: [],
      observations: [],
      situations: [],
    });
  });

  it("refuses an unreadable body as a hard parse failure", () => {
    expect(() => digitraffic("not json {{{")).toThrow("hard parse failure");
  });

  it("derives a congestion situation only at queuing or worse, pointing at its site", () => {
    const out = digitraffic();
    expect(out.situations.map((s) => s["id"])).toEqual([
      `oc:situation:${DT}:DT_FLOW_STATIONARY:congestion`,
      `oc:situation:${DT}:DT_FLOW_QUEUING:congestion`,
    ]);
    expect(out.situations[0]).toMatchObject({
      kind: "congestion",
      details: {
        derivedFrom: { class: "feature", id: `oc:feature:${DT}:DT_FLOW_STATIONARY` },
        freeFlowSource: "native",
      },
      provenance: { origin: "derived" },
    });
    expect(out.situations[0]!["headline"]).toBeUndefined();
    const stationary = site(out, DT, "DT_FLOW_STATIONARY")!;
    expect((out.situations[0]!["location"] as { geometry: unknown }).geometry).toEqual(
      (stationary["location"] as { geometry: unknown }).geometry,
    );
  });

  describe("a MultiLineString segment", () => {
    const doc = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [25.0, 60.2],
                [25.01, 60.21],
              ],
              [
                [25.02, 60.22],
                [25.03, 60.23],
              ],
            ],
          },
          properties: {
            id: "DT_MULTI_QUEUING",
            congestionLevel: "QUEUING",
            averageSpeed: 18.0,
            freeFlowSpeed: 100.0,
            measuredTime: "2026-06-24T10:00:00Z",
          },
        },
      ],
    });

    it("is one site with a multi-line geometry and one reading per property", () => {
      const out = digitraffic(doc);
      expect(out.features).toHaveLength(1);
      expect((out.features[0]!["location"] as { geometry: unknown }).geometry).toEqual({
        type: "MultiLineString",
        coordinates: [
          [
            [25.0, 60.2],
            [25.01, 60.21],
          ],
          [
            [25.02, 60.22],
            [25.03, 60.23],
          ],
        ],
      });
      expect(out.observations.map((o) => o["property"])).toEqual(["traffic.speed", "traffic.los"]);
    });

    it("derives a congestion situation per member line", () => {
      expect(digitraffic(doc).situations.map((s) => s["id"])).toEqual([
        `oc:situation:${DT}:DT_MULTI_QUEUING:0:congestion`,
        `oc:situation:${DT}:DT_MULTI_QUEUING:1:congestion`,
      ]);
    });
  });
});

describe("DATEX measured data", () => {
  const inline = () => flows(dirFeed, fixture("datex-measured-data/measured_data.xml"));

  it("reads the average speed and an inline line geometry", () => {
    const out = inline();
    expect(value(out, DIR, "NL-MS-001", "traffic.speed")).toBe(78.5);
    expect(
      (site(out, DIR, "NL-MS-001")!["location"] as { geometry: { type: string } }).geometry.type,
    ).toBe("LineString");
  });

  it("puts a level computed from the feed's own free-flow speed on the baseline, not as a reading", () => {
    const out = inline();
    expect(readings(out, DIR, "NL-MS-001", "traffic.speed")[0]!["baseline"]).toEqual({
      freeFlow: { value: 100, unit: "km/h" },
      source: "native",
      ratio: 0.785,
      los: "heavy",
    });
    expect(readings(out, DIR, "NL-MS-001", "traffic.los")).toEqual([]);
  });

  it("leaves the baseline to enrichment when the feed carries no free-flow speed", () => {
    expect(readings(inline(), DIR, "NL-MS-002", "traffic.speed")[0]!["baseline"]).toBeUndefined();
  });

  it("states a traffic status as the level of service", () => {
    const out = inline();
    expect(los(out, DIR, "NL-MS-002")).toBe("heavy");
    expect(los(out, DIR, "NL-MS-003")).toBe("stationary");
  });

  it("derives a congestion situation for a stationary site", () => {
    expect(inline().situations.map((s) => s["id"])).toEqual([
      `oc:situation:${DIR}:NL-MS-003:congestion`,
    ]);
  });

  it("refuses a document without a measured-data publication, or unreadable XML", () => {
    expect(() => flows(dirFeed, "<D2LogicalModel/>")).toThrow("hard parse failure");
    expect(() => flows(dirFeed, "<D2LogicalModel><payloadPublication")).toThrow(
      "hard parse failure",
    );
  });

  it("reads a publication without measurements as a legitimate empty cycle", () => {
    const out = flows(
      dirFeed,
      '<d2LogicalModel><payloadPublication xsi:type="MeasuredDataPublication"><siteMeasurements/></payloadPublication></d2LogicalModel>',
    );
    expect(out.observations).toEqual([]);
  });

  describe("joined to an external site table (NDW)", () => {
    const out = () => flows(ndwFeed, fixture("ndw-flow/trafficspeed.xml"), ndwSites());

    it("drafts one site per site with a resolvable location", () => {
      expect(siteIds(out(), NDW)).toEqual([
        "PZH01_MST_0065_00",
        "PZH01_MST_0029-00",
        "PZH01_MST_STANDSTILL_00",
      ]);
    });

    it("takes the site's point or line from the table", () => {
      const o = out();
      expect(
        (site(o, NDW, "PZH01_MST_0065_00")!["location"] as { geometry: unknown }).geometry,
      ).toEqual({
        type: "Point",
        coordinates: [4.536069, 52.0235558],
      });
      expect(
        (site(o, NDW, "PZH01_MST_0029-00")!["location"] as { geometry: { type: string } }).geometry
          .type,
      ).toBe("LineString");
    });

    it("states no level of service and derives no congestion without a status or baseline", () => {
      const o = out();
      expect(o.observations.filter((r) => r["property"] === "traffic.los")).toEqual([]);
      expect(o.situations).toEqual([]);
    });

    it("rejects no-data sentinels: -1, a zero with no vehicles, an absurd speed", () => {
      const ids = siteIds(out(), NDW);
      expect(ids).not.toContain("PZH01_MST_ALLNODATA_00");
      expect(ids).not.toContain("PZH01_MST_ZEROCOUNT_00");
      expect(ids).not.toContain("PZH01_MST_ABSURD_00");
    });

    it("keeps a genuine standstill: speed 0 with vehicles counted", () => {
      expect(value(out(), NDW, "PZH01_MST_STANDSTILL_00", "traffic.speed")).toBe(0);
    });

    it("drafts nothing for sites without a location in the table, or without a table", () => {
      expect(siteIds(out(), NDW)).not.toContain("PZH01_MST_MISSING_00");
      expect(flows(ndwFeed, fixture("ndw-flow/trafficspeed.xml")).features).toEqual([]);
    });
  });

  describe("streamed", () => {
    const doc = text("datex-measured-data/measured_data.xml");
    const stream = (chunks: readonly string[], sites?: FlowSites) => {
      const reader = measuredDataReader(dirFeed, sites, CTX);
      for (const chunk of chunks) reader.write(chunk);
      return reader.close();
    };

    it("drafts the same as the whole document, split mid-element", () => {
      const whole = flows(dirFeed, doc);
      const split: string[] = [];
      for (let i = 0; i < doc.length; i += 13) split.push(doc.slice(i, i + 13));
      const { failed, ...streamed } = stream(split);
      expect(failed).toBe(false);
      expect(streamed).toEqual(whole);
    });

    it("reports a truncated document as failed, keeping what resolved before the break", () => {
      const out = stream([doc.slice(0, Math.floor(doc.length * 0.6))]);
      expect(out.failed).toBe(true);
    });

    it("reports a document without the publication as failed", () => {
      expect(stream(["<D2LogicalModel/>"]).failed).toBe(true);
    });
  });

  it("reads the DATEX v1 shape: a site id as text, speed and flow as element text", () => {
    const sites = parseDatexSiteTable(`<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel><payloadPublication xsi:type="MeasurementSiteTablePublication">
  <measurementSiteTable id="Sites">
    <measurementSiteRecord id="S601">
      <measurementSiteLocation xsi:type="Point">
        <pointCoordinates><latitude>60.472024</latitude><longitude>8.468946</longitude></pointCoordinates>
      </measurementSiteLocation>
    </measurementSiteRecord>
  </measurementSiteTable>
</payloadPublication></d2LogicalModel>`);
    const feed = flowFeed("no-vegvesen-flow");
    const out = flows(
      feed,
      `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel><payloadPublication xsi:type="MeasuredDataPublication">
  <siteMeasurements>
    <measurementSiteReference>S601</measurementSiteReference>
    <measuredValue index="1"><basicDataValue xsi:type="TrafficFlow"><vehicleFlow>420</vehicleFlow></basicDataValue></measuredValue>
    <measuredValue index="3"><basicDataValue xsi:type="TrafficSpeed"><averageVehicleSpeed>101</averageVehicleSpeed></basicDataValue></measuredValue>
  </siteMeasurements>
</payloadPublication></d2LogicalModel>`,
      sites,
    );
    expect(value(out, feed.id, "S601", "traffic.speed")).toBe(101);
    expect(value(out, feed.id, "S601", "traffic.volume")).toBe(420);
    expect((site(out, feed.id, "S601")!["location"] as { geometry: unknown }).geometry).toEqual({
      type: "Point",
      coordinates: [8.468946, 60.472024],
    });
  });
});

describe("regression — existing event parsers untouched", () => {
  const DT_SOURCE = {
    id: "fi-digitraffic",
    attribution: "Fintraffic / digitraffic.fi",
    country: "FI",
    license: "CC-BY-4.0",
  } as const;

  it("parseDigitraffic still produces RoadEvents from the events fixture", () => {
    const json = readFileSync(
      join(import.meta.dirname, "fixtures/digitraffic/messages.json"),
      "utf8",
    );
    const events = parseDigitraffic(json, DT_SOURCE);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === "event")).toBe(true);
  });

  it("parseDatexSituations still produces RoadEvents from the NDW fixture", () => {
    const events = parseDatexSituations(fixture("ndw/actueel_beeld.xml"), {
      ...DT_SOURCE,
      id: "nl-ndw",
      country: "NL",
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === "event")).toBe(true);
  });
});
