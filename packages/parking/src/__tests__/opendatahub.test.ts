import { __resetSkips, drainSkipped, type ParseOutput } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { parseOpendatahub } from "../formats/opendatahub.js";
import { fixture, opendatahubFeed, parseContext } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-05-23T12:00:00Z";

function parse(sites: Buffer[], status: Buffer[]): ParseOutput {
  const out = parseOpendatahub(opendatahubFeed(), { sites, status }, parseContext(FETCHED));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const both = () =>
  parse([fixture("opendatahub-it-stations.json")], [fixture("opendatahub-it-measurements.json")]);

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => f["id"] === `oc:feature:it-32-opendatahub-parking:${stationId}`);

/** `[property, value, measured at]` of each reading of a site. */
const readings = (out: ParseOutput, stationId: string) =>
  out.observations
    .filter(
      (o) => (o["subject"] as { featureId: string }).featureId === site(out, stationId)?.["id"],
    )
    .map((o) => [
      o["property"],
      (o["result"] as { value: unknown }).value,
      (o["phenomenonTime"] as { instant: string }).instant,
    ]);

describe("opendatahub", () => {
  beforeEach(() => __resetSkips());

  test("Open Data Hub: a measurement older than an hour is no reading", () => {
    const out = both();
    expect(readings(out, "BZ-001")).toEqual([["parking.available", 120, "2026-05-23T11:55:00Z"]]);
    // Each count at its own time; the free count is published, so none is derived.
    expect(readings(out, "MR-014")).toEqual([
      ["parking.available", 50, "2026-05-23T11:55:00Z"],
      ["parking.occupied", 200, "2026-05-23T11:50:00Z"],
    ]);
    // Occupied at 10:30, 90 minutes before the poll.
    expect(readings(out, "BR-007")).toEqual([]);
  });

  test("Open Data Hub: free spaces are derived from a fresh occupied count", () => {
    const out = parse(
      [fixture("opendatahub-it-stations.json")],
      [
        json({
          data: [
            {
              scode: "BR-007",
              tname: "occupied",
              mvalue: 80,
              mvalidtime: "2026-05-23 11:40:00.000+0000",
            },
            {
              scode: "BR-007",
              tname: "occupied",
              mvalue: 70,
              mvalidtime: "2026-05-23 11:20:00.000+0000",
            },
          ],
        }),
      ],
    );
    expect(readings(out, "BR-007")).toEqual([
      ["parking.available", 40, "2026-05-23T11:40:00Z"],
      ["parking.occupied", 80, "2026-05-23T11:40:00Z"],
    ]);
  });

  test("Open Data Hub: a time without an offset is Rome time", () => {
    const out = parse(
      [fixture("opendatahub-it-stations.json")],
      [
        json({
          data: [{ scode: "BZ-001", tname: "free", mvalue: 99, mvalidtime: "2026-05-23 13:50:00" }],
        }),
      ],
    );
    // 13:50 CEST (UTC+2) is 11:50 UTC, ten minutes before the poll.
    expect(readings(out, "BZ-001")).toEqual([["parking.available", 99, "2026-05-23T11:50:00Z"]]);
  });

  test("Open Data Hub: station names, layout, capacity and charging", () => {
    const out = both();
    expect(out.features).toHaveLength(3);
    expect(drainSkipped(opendatahubFeed().id)).toEqual({ no_geometry: 1 });
    expect(site(out, "BZ-001")).toMatchObject({
      name: [{ lang: "en", text: "Bolzano Parking Centre" }],
      location: {
        geometry: { coordinates: [11.34, 46.5] },
        address: { city: "Bolzano", country: "IT" },
      },
      details: { layout: "multi_storey", capacityTotal: 480 },
      components: [
        { key: "car:ev_charging", details: { vehicleType: "car", userGroup: "ev_charging" } },
      ],
    });
    expect(site(out, "BZ-001")?.["components"]).toHaveLength(1);
    expect(site(out, "MR-014")).toMatchObject({
      name: [{ lang: "de", text: "Parkhaus Meran" }],
      details: { layout: "underground" },
    });
    expect(site(out, "BR-007")).toMatchObject({
      name: [{ lang: "it", text: "Brixen Park" }],
      details: { layout: "surface" },
    });
  });

  test("Open Data Hub: a station's origin qualifies its provider id", () => {
    const out = parse(
      [
        json({
          data: [
            {
              scode: "105",
              sname: "P05 - Laurin",
              sorigin: "skidata",
              scoordinate: { srid: 4326, x: 11.3572551, y: 46.4981741 },
              smetadata: { name_it: "Laurin", capacity: 90 },
            },
          ],
        }),
      ],
      [],
    );
    expect(site(out, "105")).toMatchObject({
      name: [{ lang: "it", text: "Laurin" }],
      externalIds: [
        { scheme: "provider", id: "105", authority: "it-32-opendatahub-parking/skidata" },
      ],
    });
  });
});

describe("opendatahub skips", () => {
  beforeEach(() => __resetSkips());

  const station = (scode: string, scoordinate: unknown) => ({ scode, sname: scode, scoordinate });
  const measurement = (
    scode: string,
    mvalue: unknown,
    mvalidtime = "2026-05-23 11:50:00.000+0000",
  ) => ({
    scode,
    tname: "free",
    mvalue,
    mvalidtime,
  });

  test("Open Data Hub: a station in another reference system has no geometry; one without an id is malformed", () => {
    const out = parse(
      [
        json({
          data: [station("A", { x: 680000, y: 5150000, srid: 25832 }), { sname: "anonymous" }],
        }),
      ],
      [json({ data: [] })],
    );
    expect(out.features).toEqual([]);
    expect(drainSkipped(opendatahubFeed().id)).toEqual({ no_geometry: 1, malformed: 1 });
  });

  test("Open Data Hub: current measurements of a station the table lacks have no site", () => {
    const out = parse(
      [
        json({
          data: [
            station("A", { x: 11.3, y: 46.5, srid: 4326 }),
            station("B", { x: null, y: null }),
          ],
        }),
      ],
      [
        json({
          data: [
            measurement("A", 5),
            measurement("GONE", 5),
            // The station is skipped already, and an old measurement is not current.
            measurement("B", 5),
            measurement("GONE", 5, "2026-05-23 09:00:00.000+0000"),
            // Other measurement types are not read.
            {
              scode: "GONE",
              tname: "parking-forecast",
              mvalue: 3,
              mvalidtime: "2026-05-23 11:50:00.000+0000",
            },
          ],
        }),
      ],
    );
    expect(out.features).toHaveLength(1);
    expect(drainSkipped(opendatahubFeed().id)).toEqual({ no_geometry: 2 });
  });

  test("Open Data Hub: a measurement without a number or a readable time is malformed", () => {
    parse(
      [fixture("opendatahub-it-stations.json")],
      [json({ data: [measurement("BZ-001", null), measurement("BZ-001", 4, "soon")] })],
    );
    expect(drainSkipped(opendatahubFeed().id)).toEqual({ no_geometry: 1, malformed: 2 });
  });
});
