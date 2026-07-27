import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseElaboratedFlow } from "../flow-elaborated.js";
import {
  createPredefinedLocationsParser,
  parsePredefinedLocations,
} from "../predefined-locations.js";
import type { SourceDescriptor } from "../types.js";

/**
 * Pins the datex-elaborated ElaboratedData + PredefinedLocations path against the
 * shape the live NRW Autobahn GmbH BAB feeds actually publish (validated against a
 * real payload 2026-07-25): an `ElaboratedDataPublication` whose basicData is
 * located by `pertinentLocation > predefinedLocationReference id`, joined to a
 * `PredefinedLocationsPublication` whose `predefinedLocation id` carries geometry as
 * `location > pointByCoordinates > pointCoordinates > latitude/longitude`. NRW uses
 * this profile where Hessen VZD / Bayern use MeasuredData + MeasurementSiteTable.
 */
const SRC: SourceDescriptor = {
  id: "de-nw-autobahn-fahrstreifen",
  attribution: "Quelle: Die Autobahn GmbH des Bundes",
  country: "DE",
  license: "GeoNutzV",
};
const dir = join(import.meta.dirname, "fixtures/autobahn-bab-nrw");
const SITE_ID = "fs.MQ_555.050_AB_SW_R_1";
const COORDS: [number, number] = [7.545113, 51.474907];

describe("Autobahn NRW ElaboratedData (datex-elaborated) — live payload shape", () => {
  it("resolves the Verortung PredefinedLocations point geometry (buffered)", () => {
    const map = parsePredefinedLocations(readFileSync(join(dir, "verortung.xml")));
    expect(map.get(SITE_ID)).toEqual({ type: "Point", coordinates: COORDS });
  });

  it("resolves the same via the streaming parser (the production site-table path)", () => {
    const parser = createPredefinedLocationsParser();
    parser.write(readFileSync(join(dir, "verortung.xml"), "utf8"));
    expect(parser.close().get(SITE_ID)).toEqual({ type: "Point", coordinates: COORDS });
  });

  it("joins the site table to the ElaboratedData and emits one geolocated flow with speed + volume", () => {
    const siteMap = parsePredefinedLocations(readFileSync(join(dir, "verortung.xml")));
    const { flows } = parseElaboratedFlow(readFileSync(join(dir, "data.xml")), SRC, siteMap);
    expect(flows).toHaveLength(1);
    const f = flows[0]!;
    expect(f.id).toBe(`de-nw-autobahn-fahrstreifen:${SITE_ID}`);
    expect(f.geometry).toEqual({ type: "Point", coordinates: COORDS });
    expect(f.speedKph).toBe(92);
    expect(f.volume).toBe(60);
    expect(f.sourceFormat).toBe("datex-elaborated");
  });

  it("skips sites with no resolvable geometry (no Verortung)", () => {
    const { flows } = parseElaboratedFlow(readFileSync(join(dir, "data.xml")), SRC);
    expect(flows).toHaveLength(0);
  });
});
