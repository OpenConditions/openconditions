import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatexMeasuredData } from "../flow.js";
import type { FlowGeometry, FlowParseResult } from "../flow.js";
import { createMeasuredDataParser } from "../measuredData.js";
import { parseDatexSiteTable } from "../siteTable.js";
import type { RoadEvent, RoadFlow } from "../model.js";

type SiteMap = Map<string, FlowGeometry>;

const DATEX_FLOW_FIXTURE = join(
  import.meta.dirname,
  "fixtures/datex-measured-data/measured_data.xml"
);
const NDW_TRAFFICSPEED_FIXTURE = join(import.meta.dirname, "fixtures/ndw-flow/trafficspeed.xml");
const NDW_SITE_TABLE_FIXTURE = join(
  import.meta.dirname,
  "fixtures/ndw-flow/measurement_site_table.xml"
);

const NDW_SOURCE = {
  id: "ndw-flow",
  attribution: "NDW / Rijkswaterstaat",
  country: "NL",
  license: "CC0-1.0",
  licenseUrl: "https://www.ndw.nu",
} as const;

/** Compare flows by their meaningful fields (everything but the non-deterministic
 * `fetchedAt` wall clock), independent of array order. */
function flowKey(f: RoadFlow): string {
  return JSON.stringify({
    id: f.id,
    los: f.los,
    speedKph: f.speedKph ?? null,
    freeFlowKph: f.freeFlowKph ?? null,
    value: f.value ?? null,
    metric: f.metric,
    kind: f.kind,
    geometry: f.geometry,
  });
}

function eventKey(e: RoadEvent): string {
  return JSON.stringify({ id: e.id, type: e.type, severity: e.severity, geometry: e.geometry });
}

function sortedFlowKeys(r: FlowParseResult): string[] {
  return r.flows.map(flowKey).sort();
}
function sortedEventKeys(r: FlowParseResult): string[] {
  return r.events.map(eventKey).sort();
}

function streamWhole(xml: string, siteMap?: SiteMap): FlowParseResult {
  const parser = createMeasuredDataParser(NDW_SOURCE, siteMap, () => "2026-06-24T10:10:00.000Z");
  parser.write(xml);
  return parser.close();
}

function streamChunked(xml: string, chunkSize: number, siteMap?: SiteMap): FlowParseResult {
  const parser = createMeasuredDataParser(NDW_SOURCE, siteMap, () => "2026-06-24T10:10:00.000Z");
  for (let i = 0; i < xml.length; i += chunkSize) {
    parser.write(xml.slice(i, i + chunkSize));
  }
  return parser.close();
}

describe("createMeasuredDataParser — equivalence with the DOM parser", () => {
  it("matches parseDatexMeasuredData on the inline-geometry fixture", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE, "utf8");
    const dom = parseDatexMeasuredData(xml, NDW_SOURCE);
    const streamed = streamWhole(xml);

    expect(streamed.flows.length).toBe(dom.flows.length);
    expect(streamed.flows.length).toBeGreaterThan(0);
    expect(sortedFlowKeys(streamed)).toEqual(sortedFlowKeys(dom));
    expect(sortedEventKeys(streamed)).toEqual(sortedEventKeys(dom));
  });

  it("matches parseDatexMeasuredData on the NDW trafficspeed feed with a site-table join", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE, "utf8");
    const siteMap = parseDatexSiteTable(readFileSync(NDW_SITE_TABLE_FIXTURE));

    const dom = parseDatexMeasuredData(xml, NDW_SOURCE, siteMap);
    const streamed = streamWhole(xml, siteMap);

    // Three sites resolve geometry from the table (including the genuine
    // standstill); the others are no-data/absurd/missing.
    expect(streamed.flows.length).toBe(dom.flows.length);
    expect(streamed.flows.length).toBe(3);
    expect(sortedFlowKeys(streamed)).toEqual(sortedFlowKeys(dom));
  });

  it("picks the highest-input-count speed sample (64), ignoring the -1 no-data sentinel", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE, "utf8");
    const siteMap = parseDatexSiteTable(readFileSync(NDW_SITE_TABLE_FIXTURE));
    const streamed = streamWhole(xml, siteMap);
    const best = streamed.flows.find((f) => f.id === "ndw-flow:PZH01_MST_0065_00");
    expect(best).toBeDefined();
    expect(best!.speedKph).toBe(64);
  });

  it("keeps a genuine standstill (speed=0, count>0) but rejects a no-data zero (speed=0, count=0) and an absurd speed (>=250)", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE, "utf8");
    const siteMap = parseDatexSiteTable(readFileSync(NDW_SITE_TABLE_FIXTURE));
    const streamed = streamWhole(xml, siteMap);
    const standstill = streamed.flows.find((f) => f.id === "ndw-flow:PZH01_MST_STANDSTILL_00");
    expect(standstill).toBeDefined();
    expect(standstill!.speedKph).toBe(0);
    expect(streamed.flows.find((f) => f.id === "ndw-flow:PZH01_MST_ZEROCOUNT_00")).toBeUndefined();
    expect(streamed.flows.find((f) => f.id === "ndw-flow:PZH01_MST_ABSURD_00")).toBeUndefined();
  });
});

describe("createMeasuredDataParser — chunk independence", () => {
  it("produces identical output whether fed whole or split mid-element", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE, "utf8");
    const whole = streamWhole(xml);
    for (const size of [1, 7, 64, 500]) {
      const chunked = streamChunked(xml, size);
      expect(sortedFlowKeys(chunked)).toEqual(sortedFlowKeys(whole));
      expect(sortedEventKeys(chunked)).toEqual(sortedEventKeys(whole));
    }
  });
});

describe("createMeasuredDataParser — derived congestion + los mapping", () => {
  it("derives a congestion event for a stationary site (matching the DOM parser)", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE, "utf8");
    const streamed = streamWhole(xml);
    const stationary = streamed.flows.find((f) => f.id.includes("NL-MS-003"));
    expect(stationary?.los).toBe("stationary");
    const congestion = streamed.events.find((e) => e.id.includes("NL-MS-003"));
    expect(congestion?.type).toBe("congestion");
  });

  it("maps an inline trafficStatus 'heavy' to los 'heavy'", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE, "utf8");
    const streamed = streamWhole(xml);
    const heavy = streamed.flows.find((f) => f.id.includes("NL-MS-002"));
    expect(heavy?.los).toBe("heavy");
  });
});

describe("createMeasuredDataParser — robustness", () => {
  it("returns empty results for an empty publication", () => {
    const parser = createMeasuredDataParser(
      NDW_SOURCE,
      undefined,
      () => "2026-06-24T10:10:00.000Z"
    );
    parser.write("<D2LogicalModel/>");
    const out = parser.close();
    expect(out.flows).toEqual([]);
    expect(out.events).toEqual([]);
  });

  it("sets failed:true when no MeasuredDataPublication is found (matches the DOM parser on the same input)", () => {
    const parser = createMeasuredDataParser(
      NDW_SOURCE,
      undefined,
      () => "2026-06-24T10:10:00.000Z"
    );
    parser.write("<D2LogicalModel/>");
    expect(parser.close().failed).toBe(true);
  });

  it("tolerates malformed/truncated XML, returning what resolved before the break", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE, "utf8");
    const truncated = xml.slice(0, Math.floor(xml.length * 0.6));
    const parser = createMeasuredDataParser(
      NDW_SOURCE,
      undefined,
      () => "2026-06-24T10:10:00.000Z"
    );
    let out: FlowParseResult | undefined;
    expect(() => {
      parser.write(truncated);
      out = parser.close();
    }).not.toThrow();
    expect(out).toBeDefined();
  });

  it("sets failed:true on truncated/malformed XML (a SAX error occurred, even though some sites resolved)", () => {
    const xml = readFileSync(DATEX_FLOW_FIXTURE, "utf8");
    const truncated = xml.slice(0, Math.floor(xml.length * 0.6));
    const parser = createMeasuredDataParser(
      NDW_SOURCE,
      undefined,
      () => "2026-06-24T10:10:00.000Z"
    );
    parser.write(truncated);
    const out = parser.close();
    expect(out.failed).toBe(true);
  });
});

describe("createMeasuredDataParser — DATEX v1 (TII/Ireland shape)", () => {
  // TII VDSData carries the site id as element TEXT (not an @id attribute) and
  // the speed as the direct text of <averageVehicleSpeed> (not a nested <speed>).
  // The companion VdsSites table places each site by a Point coordinate pair.
  const TII_SITES = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel><payloadPublication xsi:type="MeasurementSiteTablePublication">
  <measurementSiteTable id="VDSSites">
    <measurementSiteRecord id="VDS601">
      <measurementSiteLocation xsi:type="Point">
        <pointCoordinates><latitude>53.561461</latitude><longitude>-6.213296</longitude></pointCoordinates>
      </measurementSiteLocation>
    </measurementSiteRecord>
  </measurementSiteTable>
</payloadPublication></d2LogicalModel>`;

  const TII_DATA = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel><payloadPublication xsi:type="MeasuredDataPublication">
  <siteMeasurements>
    <measurementSiteReference>VDS601</measurementSiteReference>
    <measuredValue index="1"><basicDataValue xsi:type="TrafficFlow"><vehicleFlow>420</vehicleFlow></basicDataValue></measuredValue>
    <measuredValue index="3"><basicDataValue xsi:type="TrafficSpeed"><averageVehicleSpeed>101</averageVehicleSpeed></basicDataValue></measuredValue>
  </siteMeasurements>
</payloadPublication></d2LogicalModel>`;

  const TII_SOURCE = {
    id: "tii-vds-ie",
    attribution: "Transport Infrastructure Ireland",
    country: "IE",
    license: "CC-BY-4.0",
  } as const;

  it("resolves the element-text site id against a point site table and reads direct-text speed", () => {
    const siteMap = parseDatexSiteTable(TII_SITES);
    expect(siteMap.get("VDS601")).toEqual({ type: "Point", coordinates: [-6.213296, 53.561461] });

    const parser = createMeasuredDataParser(TII_SOURCE, siteMap, () => "2026-06-24T10:10:00.000Z");
    parser.write(TII_DATA);
    const out = parser.close();

    expect(out.failed).toBeFalsy();
    expect(out.flows).toHaveLength(1);
    expect(out.flows[0]!.id).toBe("tii-vds-ie:VDS601");
    expect(out.flows[0]!.speedKph).toBe(101);
    expect(out.flows[0]!.geometry).toEqual({ type: "Point", coordinates: [-6.213296, 53.561461] });
  });
});
