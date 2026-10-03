import { describe, expect, it } from "vitest";
import {
  createPredefinedLocationsParser,
  parsePredefinedLocations,
} from "../predefined-locations.js";
import { fixture, flowFeed, flows, site, siteIds, text, value } from "./flow-fixtures.js";

/**
 * Pins the datex2-elaborated ElaboratedData + PredefinedLocations path against the
 * shape the live NRW Autobahn GmbH BAB feeds actually publish (validated against a
 * real payload 2026-07-25): an `ElaboratedDataPublication` whose basicData is
 * located by `pertinentLocation > predefinedLocationReference id`, joined to a
 * `PredefinedLocationsPublication` whose `predefinedLocation id` carries geometry as
 * `location > pointByCoordinates > pointCoordinates > latitude/longitude`. NRW uses
 * this profile where Hessen VZD / Bayern use MeasuredData + MeasurementSiteTable.
 */
const FEED = "de-nw-autobahn-flow";
const SITE_ID = "fs.MQ_555.050_AB_SW_R_1";
const POINT = { type: "Point", coordinates: [7.545113, 51.474907] };

describe("Autobahn NRW ElaboratedData (datex2-elaborated) — live payload shape", () => {
  it("resolves the Verortung point and the lane it stands for", () => {
    expect(
      parsePredefinedLocations(fixture("autobahn-bab-nrw/verortung.xml")).get(SITE_ID),
    ).toEqual({
      geometry: POINT,
      lane: 1,
    });
  });

  it("resolves the same via the streaming parser (the production site-table path)", () => {
    const parser = createPredefinedLocationsParser();
    parser.write(text("autobahn-bab-nrw/verortung.xml"));
    expect(parser.close().get(SITE_ID)?.geometry).toEqual(POINT);
  });

  it("joins the site table to the ElaboratedData: one located site with speed and volume", () => {
    const out = flows(
      flowFeed(FEED),
      fixture("autobahn-bab-nrw/data.xml"),
      parsePredefinedLocations(fixture("autobahn-bab-nrw/verortung.xml")),
    );
    expect(siteIds(out, FEED)).toEqual([SITE_ID]);
    expect((site(out, FEED, SITE_ID)!["location"] as { geometry: unknown }).geometry).toEqual(
      POINT,
    );
    expect(value(out, FEED, SITE_ID, "traffic.speed")).toBe(92);
    expect(value(out, FEED, SITE_ID, "traffic.volume")).toBe(60);
  });

  it("skips sites with no resolvable geometry (no Verortung)", () => {
    expect(flows(flowFeed(FEED), fixture("autobahn-bab-nrw/data.xml")).features).toEqual([]);
  });
});
