import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatexSituations } from "../datex.js";
import { parseOpen511 } from "../open511.js";
import { parseWzdx } from "../wzdx.js";
import { parseAutobahn } from "../autobahn.js";
import { parseDigitraffic } from "../digitraffic.js";
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
