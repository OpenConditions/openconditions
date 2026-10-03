import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAutobahn } from "../autobahn.js";
import { parseDatexSituations } from "../datex.js";
import { parseDigitraffic } from "../digitraffic.js";
import { feedToSourceDescriptor } from "../feeds.js";
import { parseFlatJson } from "../flatjson.js";
import { parseGddkia } from "../gddkia.js";
import { parseGeoJson } from "../geojson.js";
import { parseIbi511 } from "../ibi511.js";
import { parseLtaIncidents } from "../lta.js";
import { parseOpen511 } from "../open511.js";
import { situationParserOf } from "../parse.js";
import { parseTrafikverket } from "../trafikverket.js";
import { parseWzdx } from "../wzdx.js";
import { testFeed } from "./helpers/test-feeds.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("situationParserOf", () => {
  it.each([
    ["datex2", parseDatexSituations],
    ["open511", parseOpen511],
    ["wzdx", parseWzdx],
    ["geojson", parseGeoJson],
    ["ibi511", parseIbi511],
    ["lta", parseLtaIncidents],
    ["gddkia", parseGddkia],
    ["autobahn", parseAutobahn],
    ["digitraffic", parseDigitraffic],
    ["flatjson", parseFlatJson],
    ["trafikverket", parseTrafikverket],
  ] as const)("returns the %s parser", (format, parser) => {
    expect(situationParserOf(format)).toBe(parser);
  });

  it("throws for an unsupported format", () => {
    expect(() => situationParserOf("traff")).toThrow(/No situation parser registered/);
  });
});

describe("Buffer tolerance", () => {
  const drivebc_src = {
    id: "ca-bc-drivebc-events",
    attribution: "DriveBC",
    country: "CA",
    license: "LicenseRef-OGL-BC",
  } as const;
  const wzdx_src = {
    id: "test-dot",
    attribution: "TestDOT",
    country: "US",
    license: "CC0-1.0",
  } as const;
  const autobahn_src = {
    id: "de-autobahn-events",
    attribution: "Autobahn GmbH des Bundes",
    country: "DE",
    license: "DL-DE-BY-2.0",
  } as const;
  const digitraffic_src = {
    id: "fi-digitraffic-events",
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
  const ndw = testFeed("nl-ndw-events");

  it("maps the feed id, attribution, country and licence", () => {
    expect(feedToSourceDescriptor(ndw)).toMatchObject({
      id: "nl-ndw-events",
      attribution: "NDW / Rijkswaterstaat",
      country: "NL",
      license: "CC0-1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    });
  });

  it("leaves the country out for a feed of no country", () => {
    const eu = testFeed("nl-ndw-events", { region: "eu", country: undefined });
    expect(feedToSourceDescriptor(eu)).not.toHaveProperty("country");
  });

  it("hands the access mode, lane numbering and extras allow-list to the parsers", () => {
    expect(feedToSourceDescriptor(ndw).accessMode).toBeUndefined();
    const descriptor = feedToSourceDescriptor({
      ...ndw,
      accessMode: "on_demand",
      laneNumbering: "left_first",
      extrasAllow: ["situationRecordExtension"],
    });
    expect(descriptor).toMatchObject({
      accessMode: "on_demand",
      laneNumbering: "left_first",
      extrasAllow: ["situationRecordExtension"],
    });
  });
});
