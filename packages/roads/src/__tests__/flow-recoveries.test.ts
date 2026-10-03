import { describe, expect, it } from "vitest";
import type { FlowSites } from "../flow-output.js";
import { parseHkDetectors } from "../hk.js";
import { parseMivConfig } from "../miv.js";
import { parsePredefinedLocations } from "../predefined-locations.js";
import { parseDatexSiteTable } from "../siteTable.js";
import { parseBcnTramsStations } from "../stations-bcn.js";
import { parseFintrafficStations } from "../stations-fintraffic.js";
import { parseWebtrisSites } from "../stations-webtris.js";
import { fixture, flowFeed, flows, readings, site, siteIds, text, value } from "./flow-fixtures.js";

/**
 * What the flow parsers keep beyond the legacy site speed: lanes and vehicle
 * classes as channels, volumes, occupancy, measurement periods and the site
 * metadata a site table or station registry carries.
 */

const ndwSites = () => parseDatexSiteTable(fixture("ndw-flow/measurement_site_table.xml"));
const ndw = (feed = flowFeed("nl-ndw-flow"), sites: FlowSites = ndwSites()) =>
  flows(feed, fixture("ndw-flow/trafficspeed.xml"), sites);
const NDW = "nl-ndw-flow";
const SITE = "PZH01_MST_0065_00";

describe("DATEX measured data", () => {
  it("reads the site table's name, lane count, equipment and per-index characteristics", () => {
    const sites = ndwSites();
    const s = sites.get(SITE)!;
    expect(s.name).toBe("N211 hmp 6.5 Re");
    expect(s.laneCount).toBe(2);
    expect(s.equipment).toBe("loop");
    expect(s.channels?.get("1")).toEqual({
      lane: 1,
      vehicleClass: "any",
      periodSec: 60,
      property: "traffic.volume",
    });
    expect(s.channels?.get("5")).toEqual({ lane: 2, periodSec: 60, property: "traffic.volume" });
    expect(s.channels?.get("11")).toEqual({
      lane: 1,
      vehicleClass: "truck",
      periodSec: 60,
      property: "traffic.speed",
    });
  });

  it("drafts the site with its metadata and one sensor channel per measured index", () => {
    const feature = site(ndw(), NDW, SITE)!;
    expect(feature["name"]).toEqual([{ lang: "nl", text: "N211 hmp 6.5 Re" }]);
    expect(feature["details"]).toMatchObject({ equipment: "loop", laneCount: 2 });
    const components = feature["components"] as { key: string; details: unknown }[];
    expect(components.map((c) => c.key)).toEqual(["1", "3", "5", "7", "8", "9", "11"]);
    expect(components.find((c) => c.key === "11")!.details).toEqual({
      kind: "sensor_channel",
      v: 1,
      index: 11,
      lane: { index: 1 },
      vehicleClass: "truck",
      property: "traffic.speed",
    });
  });

  it("averages the site speed over the speed indexes of all vehicles, weighted by their inputs", () => {
    const out = ndw();
    // Indexes 8 (64 km/h, 17 vehicles) and 9 (51 km/h, 1 vehicle); index 7 is
    // a no-data sentinel and index 11 measures lorries only.
    expect(value(out, NDW, SITE, "traffic.speed")).toBeCloseTo((64 * 17 + 51) / 18, 10);
    expect(readings(out, NDW, SITE, "traffic.speed")[0]!["quality"]).toEqual({ sampleCount: 18 });
  });

  it("keeps an index with no vehicles this interval as a channel when the table declares none", () => {
    const { channels: _declared, ...bare } = ndwSites().get(SITE)!;
    const out = ndw(flowFeed(NDW), new Map([[SITE, bare]]));
    const keys = (site(out, NDW, SITE)!["components"] as { key: string }[]).map((c) => c.key);
    // Index 7 measured no vehicles: its speed is no reading, but the site keeps the lane.
    expect(keys).toContain("7");
    expect(value(out, NDW, SITE, "traffic.speed", "7")).toBeUndefined();
  });

  it("falls back to the best-supported index when a feed reports no input counts", () => {
    const out = flows(flowFeed("fr-dir-flow"), fixture("datex-measured-data/measured_data.xml"));
    expect(value(out, "fr-dir-flow", "NL-MS-001", "traffic.speed")).toBe(78.5);
    expect(
      readings(out, "fr-dir-flow", "NL-MS-001", "traffic.speed")[0]!["quality"],
    ).toBeUndefined();
  });

  it("sums the all-vehicle volumes of the site's lanes", () => {
    // Index 1 (lane 1) and 3 (lane 2); index 5 counts long vehicles only.
    expect(value(ndw(), NDW, SITE, "traffic.volume")).toBe(2100);
  });

  it("keeps every index's value as a channel reading", () => {
    const out = ndw();
    expect(value(out, NDW, SITE, "traffic.volume", "1")).toBe(1260);
    expect(value(out, NDW, SITE, "traffic.volume", "5")).toBe(120);
    expect(value(out, NDW, SITE, "traffic.speed", "11")).toBe(80);
    expect(readings(out, NDW, SITE, "traffic.speed", "7")).toEqual([]);
  });

  it("states the measurement period as the reading's phenomenon time", () => {
    const [speed] = readings(ndw(), NDW, SITE, "traffic.speed");
    expect(speed!["phenomenonTime"]).toEqual({
      start: "2026-06-24T10:08:00.000Z",
      end: "2026-06-24T10:09:00.000Z",
    });
  });

  it("numbers lanes from the left as published for a left_first source", () => {
    const components = site(ndw(), NDW, SITE)!["components"] as {
      key: string;
      details: { lane?: { index: number } };
    }[];
    expect(components.find((c) => c.key === "8")!.details.lane).toEqual({ index: 2 });
  });

  it("converts DATEX lanes counted from the verge with the site's lane count", () => {
    const out = ndw(flowFeed("de-by-autobahn-flow"));
    const components = site(out, "de-by-autobahn-flow", SITE)!["components"] as {
      key: string;
      details: { lane?: { index: number } };
    }[];
    expect(components.find((c) => c.key === "1")!.details.lane).toEqual({ index: 2 });
    expect(components.find((c) => c.key === "8")!.details.lane).toEqual({ index: 1 });
  });

  it("keeps occupancy, overall and per index", () => {
    const doc = `<?xml version="1.0"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="MeasuredDataPublication">
    <siteMeasurements>
      <measurementSiteReference id="S1"/>
      <measurementTimeDefault>2026-06-24T10:09:00Z</measurementTimeDefault>
      <measuredValue index="1"><measuredValue><basicData xsi:type="TrafficConcentration">
        <occupancy><percentage>10</percentage></occupancy>
      </basicData></measuredValue></measuredValue>
      <measuredValue index="2"><measuredValue><basicData xsi:type="TrafficConcentration">
        <occupancy><percentage>30</percentage></occupancy>
      </basicData></measuredValue></measuredValue>
    </siteMeasurements>
  </payloadPublication>
</d2LogicalModel>`;
    const sites: FlowSites = new Map([
      ["S1", { geometry: { type: "Point", coordinates: [5, 52] } }],
    ]);
    const out = flows(flowFeed("nl-ndw-flow"), doc, sites);
    expect(value(out, NDW, "S1", "traffic.occupancy")).toBe(20);
    expect(value(out, NDW, "S1", "traffic.occupancy", "2")).toBe(30);
  });
});

describe("DATEX elaborated data", () => {
  it("keeps the per-class volume as a channel and their sum as the site volume", () => {
    const feed = "de-nw-autobahn-flow";
    const out = flows(
      flowFeed(feed),
      fixture("autobahn-bab-nrw/data.xml"),
      parsePredefinedLocations(fixture("autobahn-bab-nrw/verortung.xml")),
    );
    const id = "fs.MQ_555.050_AB_SW_R_1";
    expect(value(out, feed, id, "traffic.volume")).toBe(60);
    expect(value(out, feed, id, "traffic.volume", "volume:car")).toBe(60);
    const components = site(out, feed, id)!["components"] as { key: string; details: unknown }[];
    expect(components).toEqual([
      {
        key: "volume:car",
        kind: "sensor_channel",
        details: { kind: "sensor_channel", v: 1, vehicleClass: "car", property: "traffic.volume" },
      },
    ]);
  });

  it("keeps a class stream with no vehicles this interval as the site's channel", () => {
    const feed = "de-nw-autobahn-flow";
    const quiet = `<elaboratedData>
      <basicData xsi:type="TrafficSpeed">
        <measurementOrCalculationTime>2026-07-27T02:02:30.880+02:00</measurementOrCalculationTime>
        <pertinentLocation xsi:type="LocationByReference">
          <predefinedLocationReference id="fs.MQ_555.050_AB_SW_R_1" targetClass="PredefinedLocation" version="unknown"/>
        </pertinentLocation>
        <forVehiclesWithCharacteristicsOf><vehicleType>car</vehicleType></forVehiclesWithCharacteristicsOf>
        <averageVehicleSpeed numberOfInputValuesUsed="0"><speed>0</speed></averageVehicleSpeed>
      </basicData>
    </elaboratedData>
  </payloadPublication>`;
    const out = flows(
      flowFeed(feed),
      Buffer.from(text("autobahn-bab-nrw/data.xml").replace("</payloadPublication>", quiet)),
      parsePredefinedLocations(fixture("autobahn-bab-nrw/verortung.xml")),
    );
    const id = "fs.MQ_555.050_AB_SW_R_1";
    const keys = (site(out, feed, id)!["components"] as { key: string }[]).map((c) => c.key);
    // A component of the site, so the site does not change when the lane is quiet;
    // no reading, since a speed over no vehicles is none.
    expect(keys.sort()).toEqual(["speed:car", "volume:car"]);
    expect(value(out, feed, id, "traffic.speed", "speed:car")).toBeUndefined();
  });

  it("reads the lane a predefined location stands for", () => {
    const sites = parsePredefinedLocations(fixture("autobahn-bab-nrw/verortung.xml"));
    expect(sites.get("fs.MQ_555.050_AB_SW_R_1")?.lane).toBe(1);
  });

  it("keeps the site volume of an unclassified flow", () => {
    const feed = "de-nw-autobahn-los-flow";
    const out = flows(
      flowFeed(feed),
      fixture("autobahn-bab/elaborated.xml"),
      parsePredefinedLocations(fixture("autobahn-bab/verortung.xml")),
    );
    expect(value(out, feed, "MQ_A1_0042", "traffic.volume")).toBe(1800);
    expect(value(out, feed, "MQ_A7_0100", "traffic.volume")).toBe(900);
  });
});

describe("Fintraffic TMS", () => {
  const FEED = "fi-fintraffic-flow";
  const out = () =>
    flows(
      flowFeed(FEED),
      fixture("flow/fintraffic-tms.json"),
      parseFintrafficStations(fixture("flow/fintraffic-stations.json")),
    );

  it("makes each station direction its own site, directed along the road address", () => {
    const o = out();
    expect(siteIds(o, FEED)).toEqual(["23001-1", "23001-2"]);
    expect((site(o, FEED, "23001-2")!["location"] as { direction: unknown }).direction).toEqual({
      value: "negative",
      basis: "road_reference",
    });
    expect(site(o, FEED, "23001-1")!["components"]).toBeUndefined();
  });

  it("names the site after its station", () => {
    expect(site(out(), FEED, "23001-1")!["name"]).toEqual([
      { lang: "fi", text: "vt1_Espoo_Kehä_I" },
    ]);
  });

  it("keeps the sliding five-minute volume next to the speed, over the same period", () => {
    const o = out();
    expect(value(o, FEED, "23001-1", "traffic.speed")).toBe(95);
    expect(value(o, FEED, "23001-1", "traffic.volume")).toBe(840);
    expect(readings(o, FEED, "23001-1", "traffic.volume")[0]!["phenomenonTime"]).toEqual({
      start: "2026-03-04T14:25:00.000Z",
      end: "2026-03-04T14:30:00.000Z",
    });
  });
});

describe("MIV Flanders", () => {
  const FEED = "be-miv-flow";
  const out = () =>
    flows(flowFeed(FEED), fixture("flow/miv.xml"), parseMivConfig(fixture("flow/miv-config.xml")));

  it("keeps the per-class speeds as a vector, the summed volume and the occupancy", () => {
    const o = out();
    expect(value(o, FEED, "4970", "traffic.speed")).toBe(88);
    expect(value(o, FEED, "4970", "traffic.vehicle_class_speed")).toEqual({
      motorcycle: 95,
      car: 88,
    });
    // Vehicles per minute, as an hourly rate.
    expect(value(o, FEED, "4970", "traffic.volume")).toBe(150 * 60);
    expect(value(o, FEED, "4970", "traffic.occupancy")).toBe(12);
  });

  it("states the one-minute period and the configured name", () => {
    const o = out();
    expect(readings(o, FEED, "4970", "traffic.speed")[0]!["phenomenonTime"]).toEqual({
      start: "2026-07-10T15:20:00.000Z",
      end: "2026-07-10T15:21:00.000Z",
    });
    expect(site(o, FEED, "4970")!["name"]).toEqual([{ lang: "nl", text: "Vilvoorde R0 Brussel" }]);
  });
});

describe("HK TD", () => {
  const FEED = "hk-td-flow";
  const out = () =>
    flows(
      flowFeed(FEED),
      fixture("flow/hk-td.xml"),
      parseHkDetectors(fixture("flow/hk-detectors.csv")),
    );

  it("keeps each lane's speed, volume and occupancy as channels", () => {
    const o = out();
    expect(value(o, FEED, "AID01101", "traffic.speed", "fast_lane:speed")).toBe(100);
    expect(value(o, FEED, "AID01101", "traffic.volume", "slow_lane:volume")).toBe(120);
    expect(value(o, FEED, "AID01101", "traffic.occupancy", "fast_lane:occupancy")).toBe(8);
    expect(readings(o, FEED, "AID01101", "traffic.speed", "broken:speed")).toEqual([]);
  });

  it("sums the lane volumes and averages their occupancy over the 30-second period", () => {
    const o = out();
    expect(value(o, FEED, "AID01101", "traffic.speed")).toBe(90);
    expect(value(o, FEED, "AID01101", "traffic.volume")).toBe(4 * 120);
    expect(value(o, FEED, "AID01101", "traffic.occupancy")).toBe(6);
    expect(readings(o, FEED, "AID01101", "traffic.speed")[0]!["phenomenonTime"]).toEqual({
      start: "2026-09-19T17:55:00.000Z",
      end: "2026-09-19T17:55:30.000Z",
    });
  });

  it("names the detector after its road", () => {
    expect(site(out(), FEED, "AID01101")!["name"]).toEqual([
      { lang: "en", text: "Aberdeen Praya Road" },
    ]);
  });
});

describe("Turin FDT", () => {
  it("keeps the flow, the five-minute period and the stated accuracy", () => {
    const o = flows(flowFeed("it-turin-flow"), fixture("flow/fdt.xml"));
    expect(value(o, "it-turin-flow", "39983", "traffic.volume")).toBe(360);
    const [speed] = readings(o, "it-turin-flow", "39983", "traffic.speed");
    expect(speed!["phenomenonTime"]).toEqual({
      start: "2026-07-10T17:55:03.516Z",
      end: "2026-07-10T18:00:03.516Z",
    });
    expect(speed!["quality"]).toEqual({ confidence: 0.95 });
  });
});

describe("Madrid INFORMO", () => {
  it("keeps the volume and occupancy, dated by the poll", () => {
    const o = flows(flowFeed("es-madrid-flow"), fixture("flow/informo.xml"), undefined, {
      now: "2026-09-18T10:03:20.000Z",
      cadenceSec: 300,
    });
    expect(value(o, "es-madrid-flow", "9841", "traffic.volume")).toBe(840);
    expect(value(o, "es-madrid-flow", "9841", "traffic.occupancy")).toBe(35);
    expect(readings(o, "es-madrid-flow", "9841", "traffic.los")[0]!["phenomenonTime"]).toEqual({
      instant: "2026-09-18T10:00:00.000Z",
    });
  });
});

describe("Trafikverket TrafficFlow", () => {
  it("keeps the flow rate, also of a site that measured no speed", () => {
    const o = flows(flowFeed("se-trafikverket-flow"), fixture("flow/trafikverket-flow.json"));
    expect(value(o, "se-trafikverket-flow", "TMS-1", "traffic.volume")).toBe(800);
    expect(value(o, "se-trafikverket-flow", "TMS-3", "traffic.volume")).toBe(100);
    expect(readings(o, "se-trafikverket-flow", "TMS-3", "traffic.speed")).toEqual([]);
    expect(siteIds(o, "se-trafikverket-flow")).toEqual(["TMS-1", "TMS-3"]);
  });
});

describe("WebTRIS", () => {
  it("keeps the quarter-hour volume as an hourly rate over its period, and the site name", () => {
    const o = flows(
      flowFeed("gb-webtris", "webtris"),
      fixture("flow/webtris.json"),
      parseWebtrisSites(fixture("flow/webtris-sites.json")),
    );
    expect(value(o, "gb-webtris", "5607", "traffic.volume")).toBe(1500 * 4);
    expect(readings(o, "gb-webtris", "5607", "traffic.volume")[0]!["phenomenonTime"]).toEqual({
      start: "2026-03-04T23:44:00.000Z",
      end: "2026-03-04T23:59:00.000Z",
    });
    expect(site(o, "gb-webtris", "5607")!["name"]).toEqual([{ lang: "en", text: "MIDAS 5607" }]);
  });
});

describe("Barcelona TRAMS", () => {
  it("names the segment after its description", () => {
    const o = flows(
      flowFeed("es-bcn-ajuntament-flow"),
      fixture("flow/bcn-trams.dat"),
      parseBcnTramsStations(text("flow/bcn-trams.csv")),
    );
    expect(site(o, "es-bcn-ajuntament-flow", "2")!["name"]).toEqual([
      { lang: "ca", text: "Meridiana" },
    ]);
  });
});

describe("reading times", () => {
  it("dates a reading without a zone-bearing time by the poll, floored to the cadence", () => {
    const o = flows(flowFeed("sg-lta-flow"), fixture("flow/lta-speedbands.json"), undefined, {
      now: "2026-09-18T10:07:41.250Z",
      cadenceSec: 300,
    });
    expect(readings(o, "sg-lta-flow", "103000000", "traffic.speed")[0]!["phenomenonTime"]).toEqual({
      instant: "2026-09-18T10:05:00.000Z",
    });
  });
});
