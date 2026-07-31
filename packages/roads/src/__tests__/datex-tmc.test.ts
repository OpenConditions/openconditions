import { beforeEach, describe, expect, it } from "vitest";
import { parseDatexSituations } from "../datex.js";
import { __resetSkipMetrics, drainSkippedNoGeometry } from "../skip-metrics.js";
import type { SourceDescriptor } from "../types.js";

/**
 * Some DATEX publishers give no coordinates at all, only Alert-C location
 * codes. Entire German states published nothing usable for that reason. These
 * cover the path that places such records from the vendored location table.
 */

const SOURCE: SourceDescriptor = {
  id: "de-test-mobilithek",
  attribution: "Test",
  country: "DE",
  license: "dl-de/zero-2-0",
};

/**
 * The shape the German state feeds actually publish: DATEX v2, location nested
 * under `groupOfLocations` (not `locationReference`), and no coordinates.
 */
function alertCOnly(inner: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication xsi:type="SituationPublication" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <situation id="S1">
      <situationRecord xsi:type="Accident" id="R1">
        <situationRecordCreationTime>2026-07-31T00:00:00Z</situationRecordCreationTime>
        <validity><validityStatus>active</validityStatus></validity>
        <groupOfLocations xsi:type="Linear">${inner}</groupOfLocations>
      </situationRecord>
    </situation>
  </payloadPublication>
</d2LogicalModel>`
  );
}

/** Giengen/Herbrechtingen -> Heidenheim, a real pair from LCL 22.0. */
const LINEAR = `<alertCLinear xsi:type="AlertCMethod4Linear">
  <alertCDirection><alertCDirectionCoded>positive</alertCDirectionCoded></alertCDirection>
  <alertCLocationCountryCode>D</alertCLocationCountryCode>
  <alertCLocationTableNumber>1</alertCLocationTableNumber>
  <alertCLocationTableVersion>22.0</alertCLocationTableVersion>
  <alertCMethod4PrimaryPointLocation><alertCLocation><specificLocation>12271</specificLocation></alertCLocation></alertCMethod4PrimaryPointLocation>
  <alertCMethod4SecondaryPointLocation><alertCLocation><specificLocation>12270</specificLocation></alertCLocation></alertCMethod4SecondaryPointLocation>
</alertCLinear>`;

const version = (v: string) => LINEAR.replace("22.0", v);

describe("DATEX records carrying only an Alert-C location", () => {
  beforeEach(() => __resetSkipMetrics());

  it("places a linear location as the stretch between its coded points", () => {
    const events = parseDatexSituations(alertCOnly(LINEAR), SOURCE);

    expect(events).toHaveLength(1);
    expect(events[0]!.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [10.2075, 48.6133],
        [10.2144, 48.6899],
      ],
    });
    // Nothing was lost, so nothing should be reported as lost.
    expect(drainSkippedNoGeometry(SOURCE.id)).toBe(0);
  });

  it("records which table placed it, since the geometry is not the feed's own", () => {
    const [event] = parseDatexSituations(alertCOnly(LINEAR), SOURCE);

    expect(event!.locationTable).toMatchObject({
      ref: "TMC 58/1",
      version: "22.0",
      license: "CC-BY-4.0",
    });
    expect(event!.locationTable?.attribution).toMatch(/BASt|Bundesanstalt/);
  });

  it("still exposes the raw Alert-C reference alongside the resolved geometry", () => {
    const [event] = parseDatexSituations(alertCOnly(LINEAR), SOURCE);
    expect(event!.externalRefs?.tmc).toMatchObject({ country: "D", table: 1, code: 12271 });
  });

  it("drops a record referencing a different table edition instead of guessing", () => {
    // Codes are renumbered between editions, so an old-version record resolved
    // against ours would land on the wrong road rather than fail visibly.
    const events = parseDatexSituations(alertCOnly(version("9.00")), SOURCE);

    expect(events).toEqual([]);
    expect(drainSkippedNoGeometry(SOURCE.id)).toBe(1);
  });

  it("drops a record for a country we hold no table for", () => {
    const dutch = LINEAR.replace("<alertCLocationCountryCode>D<", "<alertCLocationCountryCode>8<")
      .replace("<alertCLocationTableNumber>1<", "<alertCLocationTableNumber>6.13<")
      .replace("22.0", "A");

    expect(parseDatexSituations(alertCOnly(dutch), SOURCE)).toEqual([]);
    expect(drainSkippedNoGeometry(SOURCE.id)).toBe(1);
  });

  it("drops a record whose Alert-C block carries the empty placeholder code", () => {
    // Brandenburg emits an otherwise-empty Alert-C block with code 0; treating
    // that as a location would place every such record at one arbitrary point.
    const zeroed = LINEAR.replace(">12271<", ">0<").replace(">12270<", ">0<");

    expect(parseDatexSituations(alertCOnly(zeroed), SOURCE)).toEqual([]);
    expect(drainSkippedNoGeometry(SOURCE.id)).toBe(1);
  });

  it("prefers the feed's own coordinates when it has them", () => {
    // The shape Bayern actually publishes: the same Alert-C block, plus the
    // precise stretch as intermediate `pointCoordinates`.
    const withCoords = `${LINEAR}<linearExtension><extendedLinear><linearByCoordinates>
      <intermediate index="1"><pointCoordinates><latitude>48.62</latitude><longitude>10.21</longitude></pointCoordinates></intermediate>
      <intermediate index="2"><pointCoordinates><latitude>48.63</latitude><longitude>10.22</longitude></pointCoordinates></intermediate>
    </linearByCoordinates></extendedLinear></linearExtension>`;

    const [event] = parseDatexSituations(alertCOnly(withCoords), SOURCE);
    // Feed coordinates are precise; the table is only as fine as its coded
    // points, so it must never override a coordinate the publisher gave.
    expect(event!.locationTable).toBeUndefined();
    expect(event!.geometry).toBeDefined();
  });
});
