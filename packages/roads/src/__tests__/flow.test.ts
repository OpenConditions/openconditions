import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDigitrafficFlow, parseDatexMeasuredData } from "../flow.js";
import { parseDatexSiteTable } from "../siteTable.js";
import type { SiteGeometry } from "../siteTable.js";
import { parseDigitraffic } from "../digitraffic.js";
import { parseDatexSituations } from "../datex.js";

const DT_FLOW_FIXTURE = join(import.meta.dirname, "fixtures/digitraffic-flow/flow.json");
const DATEX_FLOW_FIXTURE = join(
  import.meta.dirname,
  "fixtures/datex-measured-data/measured_data.xml"
);
const DT_EVENTS_FIXTURE = join(import.meta.dirname, "fixtures/digitraffic/messages.json");
const NDW_FIXTURE = join(import.meta.dirname, "fixtures/ndw/actueel_beeld.xml");
const NDW_SITE_TABLE_FIXTURE = join(
  import.meta.dirname,
  "fixtures/ndw-flow/measurement_site_table.xml"
);
const NDW_TRAFFICSPEED_FIXTURE = join(import.meta.dirname, "fixtures/ndw-flow/trafficspeed.xml");

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

describe("parseDigitrafficFlow — MultiLineString geometry", () => {
  const multiLineFeature = {
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
  };

  it("accepts MultiLineString geometry and emits one RoadFlow per member line", () => {
    const { flows } = parseDigitrafficFlow(multiLineFeature, DT_SOURCE);
    expect(flows).toHaveLength(2);
    expect(flows.every((f) => f.geometry.type === "LineString")).toBe(true);
  });

  it("all member-line flows share the same los and source id", () => {
    const { flows } = parseDigitrafficFlow(multiLineFeature, DT_SOURCE);
    expect(flows.every((f) => f.los === "queuing")).toBe(true);
    expect(flows.every((f) => f.source === "digitraffic-fi")).toBe(true);
  });

  it("emits a derived congestion event for each member-line when los >= queuing", () => {
    const { events } = parseDigitrafficFlow(multiLineFeature, DT_SOURCE);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "congestion")).toBe(true);
  });

  it("member-line flow ids are disambiguated with a line index suffix", () => {
    const { flows } = parseDigitrafficFlow(multiLineFeature, DT_SOURCE);
    expect(flows[0]!.id).toBe("digitraffic-fi:DT_MULTI_QUEUING:0");
    expect(flows[1]!.id).toBe("digitraffic-fi:DT_MULTI_QUEUING:1");
  });

  it("each member-line geometry carries its own coordinates", () => {
    const { flows } = parseDigitrafficFlow(multiLineFeature, DT_SOURCE);
    expect(flows[0]!.geometry.coordinates).toEqual([
      [25.0, 60.2],
      [25.01, 60.21],
    ]);
    expect(flows[1]!.geometry.coordinates).toEqual([
      [25.02, 60.22],
      [25.03, 60.23],
    ]);
  });
});

describe("parseDatexMeasuredData — site-table geometry fallback", () => {
  const siteTableXml = `<?xml version="1.0" encoding="UTF-8"?>
<D2LogicalModel modelBaseVersion="2">
  <measurementSiteTable id="MST-001" version="1">
    <measurementSite id="NL-SITE-A" version="1">
      <measurementSiteLocation>
        <gmlLineString srsName="WGS 84">
          <gml:posList xmlns:gml="http://www.opengis.net/gml">
            52.3700 4.8950 52.3720 4.8990
          </gml:posList>
        </gmlLineString>
      </measurementSiteLocation>
    </measurementSite>
  </measurementSiteTable>
  <payloadPublication xsi:type="MeasuredDataPublication"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <publicationTime>2026-06-24T10:00:00Z</publicationTime>
    <siteMeasurements>
      <measurementSiteReference id="NL-SITE-A" version="1"/>
      <measurementTimeDefault>2026-06-24T10:00:00Z</measurementTimeDefault>
      <measuredValue index="1">
        <basicDataValue xsi:type="TrafficStatus">
          <trafficStatus>queuing</trafficStatus>
          <averageVehicleSpeed>
            <dataError>false</dataError>
            <speed>22.0</speed>
          </averageVehicleSpeed>
        </basicDataValue>
      </measuredValue>
    </siteMeasurements>
  </payloadPublication>
</D2LogicalModel>`;

  it("resolves geometry from measurementSiteTable when measuredValue has no locationReference", () => {
    const { flows } = parseDatexMeasuredData(Buffer.from(siteTableXml), NDW_SOURCE);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.geometry.type).toBe("LineString");
  });

  it("correctly maps the site-table geometry coordinates", () => {
    const { flows } = parseDatexMeasuredData(Buffer.from(siteTableXml), NDW_SOURCE);
    const coords = flows[0]!.geometry.coordinates;
    expect(coords[0]).toEqual([4.895, 52.37]);
    expect(coords[1]).toEqual([4.899, 52.372]);
  });

  it("emits a derived congestion event when site-table geometry is resolved and los >= queuing", () => {
    const { events } = parseDatexMeasuredData(Buffer.from(siteTableXml), NDW_SOURCE);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("congestion");
    expect(events[0]!.severity).toBe("high");
  });

  it("uses inline locationReference first, ignoring site-table when both are present", () => {
    const bothXml = `<?xml version="1.0" encoding="UTF-8"?>
<D2LogicalModel modelBaseVersion="2">
  <measurementSiteTable id="MST-001" version="1">
    <measurementSite id="NL-SITE-B" version="1">
      <measurementSiteLocation>
        <gmlLineString srsName="WGS 84">
          <gml:posList xmlns:gml="http://www.opengis.net/gml">
            99.0 99.0 99.1 99.1
          </gml:posList>
        </gmlLineString>
      </measurementSiteLocation>
    </measurementSite>
  </measurementSiteTable>
  <payloadPublication xsi:type="MeasuredDataPublication"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <publicationTime>2026-06-24T10:00:00Z</publicationTime>
    <siteMeasurements>
      <measurementSiteReference id="NL-SITE-B" version="1"/>
      <measurementTimeDefault>2026-06-24T10:00:00Z</measurementTimeDefault>
      <measuredValue index="1">
        <basicDataValue xsi:type="TrafficStatus">
          <trafficStatus>heavy</trafficStatus>
        </basicDataValue>
        <locationReference>
          <gmlLineString srsName="WGS 84">
            <gml:posList xmlns:gml="http://www.opengis.net/gml">
              52.3500 4.8700 52.3520 4.8720
            </gml:posList>
          </gmlLineString>
        </locationReference>
      </measuredValue>
    </siteMeasurements>
  </payloadPublication>
</D2LogicalModel>`;
    const { flows } = parseDatexMeasuredData(Buffer.from(bothXml), NDW_SOURCE);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.geometry.coordinates[0]).toEqual([4.87, 52.35]);
  });
});

describe("parseDatexSiteTable — fixture", () => {
  it("maps a Point site record to a Point geometry from locationForDisplay", () => {
    const xml = readFileSync(NDW_SITE_TABLE_FIXTURE);
    const map = parseDatexSiteTable(xml);
    const point = map.get("PZH01_MST_0065_00");
    expect(point).toBeDefined();
    expect(point!.type).toBe("Point");
    expect((point as { coordinates: number[] }).coordinates).toEqual([4.536069, 52.0235558]);
  });

  it("maps an ItineraryByIndexedLocations/Linear record to a LineString from start/end coordinates", () => {
    const xml = readFileSync(NDW_SITE_TABLE_FIXTURE);
    const map = parseDatexSiteTable(xml);
    const line = map.get("PZH01_MST_0029-00");
    expect(line).toBeDefined();
    expect(line!.type).toBe("LineString");
    expect((line as { coordinates: number[][] }).coordinates).toEqual([
      [4.675, 52.009],
      [4.6765, 52.0076],
    ]);
  });

  it("skips records with no resolvable location", () => {
    const xml = readFileSync(NDW_SITE_TABLE_FIXTURE);
    const map = parseDatexSiteTable(xml);
    expect(map.has("PZH01_MST_NOLOC_00")).toBe(false);
  });

  it("never throws on empty XML", () => {
    expect(() => parseDatexSiteTable(Buffer.from("<d2LogicalModel/>"))).not.toThrow();
    expect(parseDatexSiteTable(Buffer.from("<d2LogicalModel/>")).size).toBe(0);
  });
});

describe("parseDatexMeasuredData — external site-map join (NDW shape)", () => {
  function siteMap(): Map<string, SiteGeometry> {
    return parseDatexSiteTable(readFileSync(NDW_SITE_TABLE_FIXTURE));
  }

  it("produces one aggregated RoadFlow per resolvable site", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE, siteMap());
    const ids = flows.map((f) => f.id).sort();
    expect(ids).toEqual(["ndw:PZH01_MST_0029-00", "ndw:PZH01_MST_0065_00"]);
  });

  it("uses the speed sample with the highest numberOfInputValuesUsed and ignores no-data (-1)", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE, siteMap());
    const site = flows.find((f) => f.id === "ndw:PZH01_MST_0065_00")!;
    expect(site.speedKph).toBe(64);
    expect(site.value).toBe(64);
    expect(site.unit).toBe("km/h");
  });

  it("attaches the external site geometry (Point) to the aggregated flow", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE, siteMap());
    const site = flows.find((f) => f.id === "ndw:PZH01_MST_0065_00")!;
    expect(site.geometry.type).toBe("Point");
    expect((site.geometry as { coordinates: number[] }).coordinates).toEqual([
      4.536069, 52.0235558,
    ]);
  });

  it("attaches the external site geometry (LineString) when the site resolves to a line", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE, siteMap());
    const site = flows.find((f) => f.id === "ndw:PZH01_MST_0029-00")!;
    expect(site.geometry.type).toBe("LineString");
  });

  it("sets los:'unknown' (no free-flow baseline) and emits no derived congestion event", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE);
    const { flows, events } = parseDatexMeasuredData(xml, NDW_SOURCE, siteMap());
    expect(flows.every((f) => f.los === "unknown")).toBe(true);
    expect(flows.every((f) => f.level === "unknown")).toBe(true);
    expect(events).toHaveLength(0);
  });

  it("skips a site whose speed samples are all no-data (-1)", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE, siteMap());
    expect(flows.find((f) => f.id === "ndw:PZH01_MST_ALLNODATA_00")).toBeUndefined();
  });

  it("skips a site that is absent from the site map (no geometry)", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE, siteMap());
    expect(flows.find((f) => f.id === "ndw:PZH01_MST_MISSING_00")).toBeUndefined();
  });

  it("skips all sites when no site map is provided and geometry is external-only", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE);
    expect(flows).toHaveLength(0);
  });

  it("emits measurement metadata sensibly (metric/aggregation/kind)", () => {
    const xml = readFileSync(NDW_TRAFFICSPEED_FIXTURE);
    const { flows } = parseDatexMeasuredData(xml, NDW_SOURCE, siteMap());
    expect(flows.every((f) => f.kind === "measurement")).toBe(true);
    expect(flows.every((f) => f.metric === "flow")).toBe(true);
    expect(flows.every((f) => f.aggregation === "live")).toBe(true);
  });
});
