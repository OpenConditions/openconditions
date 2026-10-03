import { describe, expect, it } from "vitest";
import { measuredDataReader } from "../parse.js";
import { parseDatexSiteTable } from "../siteTable.js";
import { CTX, fixture, flowFeed, flows, site, siteIds, text, value } from "./flow-fixtures.js";

/**
 * Pins the datex2 MeasuredData + MeasurementSiteTable path against the shape the
 * live Autobahn GmbH BAB Mobilithek feeds actually publish (validated against a
 * real payload 2026-07-24): a `MeasuredDataPublication` keyed by
 * `measurementSiteReference id`, joined to a `MeasurementSiteTablePublication`
 * whose `measurementSiteRecord` carries geometry as
 * `measurementSiteLocation > pointByCoordinates > pointCoordinates >
 * latitude/longitude`.
 */
const FEED = "de-he-autobahn-vzd";
const feed = flowFeed(FEED);
const POINT = { type: "Point", coordinates: [8.6821, 50.1109] };
const sites = () => parseDatexSiteTable(fixture("autobahn-bab-datex2/verortung.xml"));

describe("Autobahn BAB MeasuredData (datex2) — live payload shape", () => {
  it("resolves the Verortung MeasurementSiteTable point geometry", () => {
    expect(sites().get("eq.test_001.f.de")).toEqual({ geometry: POINT });
  });

  it("joins the site table to the MeasuredData: one located site with its speed", () => {
    const out = flows(feed, fixture("autobahn-bab-datex2/measured.xml"), sites());
    expect(siteIds(out, FEED)).toEqual(["eq.test_001.f.de"]);
    expect(
      (site(out, FEED, "eq.test_001.f.de")!["location"] as { geometry: unknown }).geometry,
    ).toEqual(POINT);
    expect(value(out, FEED, "eq.test_001.f.de", "traffic.speed")).toBe(85);
  });

  it("skips sites with no resolvable external geometry", () => {
    expect(flows(feed, fixture("autobahn-bab-datex2/measured.xml")).features).toEqual([]);
  });

  it("the streaming reader (the production path for these feeds) handles the same shape", () => {
    const reader = measuredDataReader(feed, sites(), CTX);
    reader.write(text("autobahn-bab-datex2/measured.xml"));
    const out = reader.close();
    expect(value(out, FEED, "eq.test_001.f.de", "traffic.speed")).toBe(85);
  });
});
