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

  it("reads an Alert-C block declared inline on the location element", () => {
    // Publishers differ: some nest an `alertCLinear` element, others type the
    // location element itself `AlertCLinear` and put the fields directly on it.
    const inline = `<alertCDirection><alertCDirectionCoded>positive</alertCDirectionCoded></alertCDirection>
      <alertCLocationCountryCode>D</alertCLocationCountryCode>
      <alertCLocationTableNumber>1</alertCLocationTableNumber>
      <alertCLocationTableVersion>22.0</alertCLocationTableVersion>
      <alertCMethod4PrimaryPointLocation><alertCLocation><specificLocation>12271</specificLocation></alertCLocation></alertCMethod4PrimaryPointLocation>
      <alertCMethod4SecondaryPointLocation><alertCLocation><specificLocation>12270</specificLocation></alertCLocation></alertCMethod4SecondaryPointLocation>`;

    const xml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication xsi:type="SituationPublication" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <situation id="S1">
      <situationRecord xsi:type="Accident" id="R1">
        <situationRecordCreationTime>2026-07-31T00:00:00Z</situationRecordCreationTime>
        <validity><validityStatus>active</validityStatus></validity>
        <groupOfLocations xsi:type="AlertCLinear">${inline}</groupOfLocations>
      </situationRecord>
    </situation>
  </payloadPublication>
</d2LogicalModel>`
    );

    const [event] = parseDatexSituations(xml, SOURCE);
    expect(event!.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [10.2075, 48.6133],
        [10.2144, 48.6899],
      ],
    });
    expect(event!.locationTable).toMatchObject({ ref: "TMC 58/1", version: "22.0" });
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

/**
 * A v2 `linearByCoordinates` carries its endpoints as latitude/longitude
 * directly under `start`/`end`, unlike v3 which nests a `pointCoordinates`.
 * Only the nested form was read, so a record whose whole geometry was its two
 * endpoints resolved to nothing and was dropped.
 */
describe("DATEX linearByCoordinates endpoints", () => {
  beforeEach(() => __resetSkipMetrics());

  const linear = (inner: string) =>
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication xsi:type="SituationPublication" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <situation id="S1">
      <situationRecord xsi:type="Accident" id="R1">
        <situationRecordCreationTime>2026-07-31T00:00:00Z</situationRecordCreationTime>
        <validity><validityStatus>active</validityStatus></validity>
        <groupOfLocations xsi:type="Linear"><linearByCoordinates>${inner}</linearByCoordinates></groupOfLocations>
      </situationRecord>
    </situation>
  </payloadPublication>
</d2LogicalModel>`
    );

  const START_END = `
    <start><latitude>48.6206291</latitude><longitude>10.2168311</longitude></start>
    <end><latitude>48.6304951</latitude><longitude>10.2203178</longitude></end>`;

  it("keeps a record whose only geometry is its two endpoints", () => {
    const events = parseDatexSituations(linear(START_END), SOURCE);

    expect(events).toHaveLength(1);
    // Both endpoints, as a MultiPoint: the two ends of a stretch with no road
    // path between them. Joining them into a line would invent a chord across
    // whatever the road actually does.
    expect(events[0]!.geometry).toEqual({
      type: "MultiPoint",
      coordinates: [
        [10.2168311, 48.6206291],
        [10.2203178, 48.6304951],
      ],
    });
    expect(drainSkippedNoGeometry(SOURCE.id)).toBe(0);
  });

  it("keeps the intermediate points that trace the road, alongside the endpoints", () => {
    const events = parseDatexSituations(
      linear(
        `${START_END}<intermediate index="1"><pointCoordinates><latitude>48.625</latitude><longitude>10.218</longitude></pointCoordinates></intermediate>`
      ),
      SOURCE
    );

    const geom = events[0]!.geometry;
    expect(geom?.type).toBe("MultiPoint");
    const coords = geom && "coordinates" in geom ? geom.coordinates : [];
    expect(coords).toHaveLength(3);
    expect(coords).toContainEqual([10.218, 48.625]);
  });

  it("still walks a start/end that is not a coordinate pair", () => {
    // `start`/`end` name non-coordinate things elsewhere in DATEX, so
    // intercepting the name must not stop the search for nested geometry.
    const events = parseDatexSituations(
      linear(
        `<start><pointCoordinates><latitude>48.62</latitude><longitude>10.21</longitude></pointCoordinates></start>`
      ),
      SOURCE
    );

    expect(events[0]!.geometry).toEqual({ type: "Point", coordinates: [10.21, 48.62] });
  });
});
