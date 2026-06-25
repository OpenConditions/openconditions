import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatexSituations } from "../datex.js";
import { parseOpen511 } from "../open511.js";
import { parseWzdx } from "../wzdx.js";
import { parseAutobahn } from "../autobahn.js";
import { parseDigitraffic } from "../digitraffic.js";
import { parseGeoJson } from "../geojson.js";
import { parseIbi511 } from "../ibi511.js";
import { parseLtaIncidents } from "../lta.js";
import { parseGddkia } from "../gddkia.js";
import { FEED_SOURCES, feedToSourceDescriptor, parserFor } from "../feeds.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("FEED_SOURCES", () => {
  it("includes an ndw entry", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw");
    expect(ndw).toBeDefined();
  });

  it("ndw entry has format datex2", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    expect(ndw.format).toBe("datex2");
  });

  it("ndw entry has gzip:true", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    expect(ndw.gzip).toBe(true);
  });

  it("ndw entry has license CC0-1.0", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    expect(ndw.license).toBe("CC0-1.0");
  });

  it("includes an ndw-flow entry that produces flow with a companion site table", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "ndw-flow");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.produces).toBe("flow");
    expect(feed!.gzip).toBe(true);
    expect(feed!.enabledByDefault).toBe(true);
    expect(feed!.siteTable).toEqual({
      url: "https://opendata.ndw.nu/measurement.xml.gz",
      gzip: true,
    });
    expect(feed!.url).toBe("https://opendata.ndw.nu/trafficspeed.xml.gz");
  });

  it("no longer registers the dead digitraffic-fi-flow feed", () => {
    expect(FEED_SOURCES.find((f) => f.id === "digitraffic-fi-flow")).toBeUndefined();
  });

  it("includes drivebc with format open511 and license OGL-BC", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "drivebc");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("open511");
    expect(feed!.license).toBe("OGL-BC");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes digitraffic-fi with format digitraffic-json and license CC-BY-4.0", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "digitraffic-fi");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("digitraffic-json");
    expect(feed!.license).toBe("CC-BY-4.0");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes autobahn-de discovering all motorways (no static url)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "autobahn-de");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("autobahn-json");
    expect(feed!.license).toBe("dl-de/by-2-0");
    expect(feed!.enabledByDefault).toBe(true);
    expect(typeof feed!.discover).toBe("function");
    expect(feed!.url).toBeUndefined();
  });

  it("includes wzdx enabled, discovering the feed registry (no static url)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "wzdx");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("wzdx");
    expect(feed!.enabledByDefault).toBe(true);
    expect(typeof feed!.discover).toBe("function");
    expect(feed!.url).toBeUndefined();
  });

  it("includes dgt-es (Spain) as an open DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "dgt-es");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.license).toBe("CC-BY-4.0");
    expect(feed!.country).toBe("ES");
    expect(typeof feed!.url).toBe("string");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes svzbw-de (Baden-Württemberg roadworks) as an open DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "svzbw-de");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.license).toBe("dl-de/by-2-0");
    expect(feed!.country).toBe("DE");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes dir-fr (France DIR) as an open DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "dir-fr");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.license).toBe("etalab-2.0");
    expect(feed!.country).toBe("FR");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes hc-hr (Croatia) as a Basic-auth DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "hc-hr");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth).toEqual({
      kind: "basic",
      userEnvVar: "HC_HR_USERNAME",
      passEnvVar: "HC_HR_PASSWORD",
    });
  });

  it("includes nzta-nz (New Zealand) as an open GeoJSON feed with a mapping", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "nzta-nz");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.license).toBe("CC-BY-4.0");
    expect(feed!.geojson?.typeField).toBe("eventDescription");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes berlin-de (Berlin VIZ) as an open GeoJSON feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "berlin-de");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.license).toBe("dl-de/by-2-0");
    expect(feed!.country).toBe("DE");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes the iPeloton/IBI511 fleet (Ontario + 511NY) as query-key feeds", () => {
    for (const id of ["on-511", "ny-511"]) {
      const feed = FEED_SOURCES.find((f) => f.id === id);
      expect(feed, id).toBeDefined();
      expect(feed!.format).toBe("ibi511-json");
      expect(feed!.auth?.kind).toBe("query-key");
    }
  });

  it("includes lta-sg (Singapore) as a header-key lta-json feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "lta-sg");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("lta-json");
    expect(feed!.auth).toEqual({
      kind: "header-key",
      header: "AccountKey",
      envVar: "LTA_ACCOUNT_KEY",
    });
  });

  it("includes mtq-qc (Québec) as an open GeoJSON feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "mtq-qc");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.license).toBe("CC-BY-4.0");
    expect(feed!.geojson?.defaultType).toBe("roadworks");
  });

  it("includes gddkia-pl (Poland) as a CC0 gddkia-xml feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "gddkia-pl");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("gddkia-xml");
    expect(feed!.license).toBe("CC0-1.0");
    expect(feed!.country).toBe("PL");
  });

  it("includes vegvesen-no (Norway) as a Basic-auth DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "vegvesen-no");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth?.kind).toBe("basic");
    expect(feed!.country).toBe("NO");
  });

  it("includes vegagerdin-is (Iceland) as a GeoJSON feed with lon/lat fields", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "vegagerdin-is");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.geojson?.lonField).toBe("X");
    expect(feed!.geojson?.latField).toBe("Y");
  });

  it("includes qld-traffic (Queensland) as a query-key GeoJSON feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "qld-traffic");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.auth?.kind).toBe("query-key");
    expect(feed!.license).toBe("CC-BY-4.0");
  });

  it("includes cita-lu (Luxembourg) as a CC0 DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "cita-lu");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.license).toBe("CC0-1.0");
    expect(feed!.country).toBe("LU");
  });

  it("includes brussels-be as a CC0 GeoJSON feed (EPSG:3812 reprojected)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "brussels-be");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.license).toBe("CC0-1.0");
    expect(feed!.country).toBe("BE");
  });

  it("includes flanders-be (Flanders) as a DATEX II feed (EPSG:31370 reprojected)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "flanders-be");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.country).toBe("BE");
  });

  it("includes trafficsa-au (South Australia) as a CC-BY GeoJSON feed (2 layers)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "trafficsa-au");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(Array.isArray(feed!.url)).toBe(true);
    expect(feed!.license).toBe("CC-BY-4.0");
  });

  it("registers unique feed ids", () => {
    const ids = FEED_SOURCES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parserFor", () => {
  it("returns parseDatexSituations for datex2", () => {
    expect(parserFor("datex2")).toBe(parseDatexSituations);
  });

  it("returns parseOpen511 for open511", () => {
    expect(parserFor("open511")).toBe(parseOpen511);
  });

  it("returns parseWzdx for wzdx", () => {
    expect(parserFor("wzdx")).toBe(parseWzdx);
  });

  it("returns parseGeoJson for geojson", () => {
    expect(parserFor("geojson")).toBe(parseGeoJson);
  });

  it("returns parseIbi511 for ibi511-json", () => {
    expect(parserFor("ibi511-json")).toBe(parseIbi511);
  });

  it("returns parseLtaIncidents for lta-json", () => {
    expect(parserFor("lta-json")).toBe(parseLtaIncidents);
  });

  it("returns parseGddkia for gddkia-xml", () => {
    expect(parserFor("gddkia-xml")).toBe(parseGddkia);
  });

  it("returns parseAutobahn for autobahn-json", () => {
    expect(parserFor("autobahn-json")).toBe(parseAutobahn);
  });

  it("returns parseDigitraffic for digitraffic-json", () => {
    expect(parserFor("digitraffic-json")).toBe(parseDigitraffic);
  });

  it("throws for an unsupported format", () => {
    expect(() => parserFor("traff" as never)).toThrow(/No parser registered/);
  });
});

describe("Buffer tolerance", () => {
  const drivebc_src = {
    id: "drivebc",
    attribution: "DriveBC",
    country: "CA",
    license: "OGL-BC",
  } as const;
  const wzdx_src = {
    id: "test-dot",
    attribution: "TestDOT",
    country: "US",
    license: "CC0-1.0",
  } as const;
  const autobahn_src = {
    id: "autobahn-de",
    attribution: "Autobahn GmbH des Bundes",
    country: "DE",
    license: "dl-de/by-2-0",
  } as const;
  const digitraffic_src = {
    id: "digitraffic-fi",
    attribution: "Fintraffic / Digitraffic",
    country: "FI",
    license: "CC-BY-4.0",
  } as const;

  it("parseOpen511 accepts a Buffer and yields the same event count as the object", () => {
    const obj = JSON.parse(readFileSync(join(FIXTURES, "drivebc/events.json"), "utf8"));
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const fromObj = parseOpen511(obj, drivebc_src);
    const fromBuf = parseOpen511(buf, drivebc_src);
    expect(fromBuf.length).toBeGreaterThan(0);
    expect(fromBuf.length).toBe(fromObj.length);
  });

  it("parseWzdx accepts a Buffer and yields the same event count as the object", () => {
    const obj = JSON.parse(readFileSync(join(FIXTURES, "wzdx/feed.json"), "utf8"));
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const fromObj = parseWzdx(obj, wzdx_src);
    const fromBuf = parseWzdx(buf, wzdx_src);
    expect(fromBuf.length).toBeGreaterThan(0);
    expect(fromBuf.length).toBe(fromObj.length);
  });

  it("parseAutobahn accepts a Buffer and yields the same event count as the object", () => {
    const obj = JSON.parse(readFileSync(join(FIXTURES, "autobahn/warning.json"), "utf8"));
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const fromObj = parseAutobahn(obj, autobahn_src, "warning");
    const fromBuf = parseAutobahn(buf, autobahn_src, "warning");
    expect(fromBuf.length).toBeGreaterThan(0);
    expect(fromBuf.length).toBe(fromObj.length);
  });

  it("parseDigitraffic accepts a Buffer and yields the same event count as the object", () => {
    const obj = JSON.parse(readFileSync(join(FIXTURES, "digitraffic/messages.json"), "utf8"));
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const fromObj = parseDigitraffic(obj, digitraffic_src);
    const fromBuf = parseDigitraffic(buf, digitraffic_src);
    expect(fromBuf.length).toBeGreaterThan(0);
    expect(fromBuf.length).toBe(fromObj.length);
  });
});

describe("feedToSourceDescriptor", () => {
  it("maps ndw feed to a SourceDescriptor with matching license", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    const desc = feedToSourceDescriptor(ndw);
    expect(desc.license).toBe("CC0-1.0");
  });

  it("maps ndw feed id and attribution correctly", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    const desc = feedToSourceDescriptor(ndw);
    expect(desc.id).toBe("ndw");
    expect(desc.attribution).toBe("NDW / Rijkswaterstaat");
  });

  it("includes licenseUrl when present", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "ndw")!;
    const desc = feedToSourceDescriptor(ndw);
    expect(desc.licenseUrl).toBeDefined();
  });
});
