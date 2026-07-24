import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatexMeasuredData } from "../flow.js";
import { createMeasuredDataParser } from "../measuredData.js";
import { parseDatexSiteTable } from "../siteTable.js";
import type { SourceDescriptor } from "../types.js";

/**
 * Pins the datex2 MeasuredData + MeasurementSiteTable path against the shape the
 * live Autobahn GmbH BAB Mobilithek feeds actually publish (validated against a
 * real payload 2026-07-24): a `MeasuredDataPublication` keyed by
 * `measurementSiteReference id`, joined to a `MeasurementSiteTablePublication`
 * whose `measurementSiteRecord` carries geometry as
 * `measurementSiteLocation > pointByCoordinates > pointCoordinates >
 * latitude/longitude`. (The feeds were originally, wrongly, built against the
 * ElaboratedData/PredefinedLocations profile while payloads were access-gated.)
 */
const SRC: SourceDescriptor = {
  id: "de-he-autobahn-vzd",
  attribution: "Quelle: Die Autobahn GmbH des Bundes",
  country: "DE",
  license: "GeoNutzV",
};
const dir = join(import.meta.dirname, "fixtures/autobahn-bab-datex2");

describe("Autobahn BAB MeasuredData (datex2) — live payload shape", () => {
  it("resolves the Verortung MeasurementSiteTable point geometry", () => {
    const siteMap = parseDatexSiteTable(readFileSync(join(dir, "verortung.xml")));
    expect(siteMap.get("eq.test_001.f.de")).toEqual({
      type: "Point",
      coordinates: [8.6821, 50.1109],
    });
  });

  it("joins the site table to the MeasuredData and emits one geolocated flow", () => {
    const siteMap = parseDatexSiteTable(readFileSync(join(dir, "verortung.xml")));
    const { flows } = parseDatexMeasuredData(readFileSync(join(dir, "measured.xml")), SRC, siteMap);
    expect(flows).toHaveLength(1);
    const f = flows[0]!;
    expect(f.id).toBe("de-he-autobahn-vzd:eq.test_001.f.de");
    expect(f.geometry).toEqual({ type: "Point", coordinates: [8.6821, 50.1109] });
    expect(f.speedKph).toBe(85);
    expect(f.sourceFormat).toBe("datex2");
  });

  it("skips sites with no resolvable geometry (Bayern with no Verortung offer)", () => {
    // No siteMap → the measurementSiteReference can't resolve → no flow emitted.
    const { flows } = parseDatexMeasuredData(readFileSync(join(dir, "measured.xml")), SRC);
    expect(flows).toHaveLength(0);
  });

  it("the streaming parser (the production path for these feeds) handles the same shape", () => {
    const siteMap = parseDatexSiteTable(readFileSync(join(dir, "verortung.xml")));
    const parser = createMeasuredDataParser(SRC, siteMap);
    parser.write(readFileSync(join(dir, "measured.xml"), "utf8"));
    const { flows } = parser.close();
    expect(flows).toHaveLength(1);
    expect(flows[0]!.geometry).toEqual({ type: "Point", coordinates: [8.6821, 50.1109] });
    expect(flows[0]!.speedKph).toBe(85);
  });
});
