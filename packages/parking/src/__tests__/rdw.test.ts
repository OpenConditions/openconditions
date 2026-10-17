import { __resetSkips, drainSkipped, type ParseOutput } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { parseRdw } from "../formats/rdw.js";
import { fixture, parseContext, rdwFeed } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-05T04:00:00Z";

function parse(specs: Buffer[], areas: Buffer[]): ParseOutput {
  const out = parseRdw(rdwFeed(), { specs, areas }, parseContext(FETCHED, 86400));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

const AREAS = ["rdw-nl-garage.json", "rdw-nl-pnr.json", "rdw-nl-carpool.json"];

const fixtures = () =>
  parse(
    [fixture("rdw-nl-specs.json")],
    AREAS.map((name) => fixture(name)),
  );

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => f["id"] === `oc:feature:nl-rdw-parking:${stationId}`);

const areas = (out: ParseOutput, stationId: string) =>
  (
    (site(out, stationId)?.["components"] ?? []) as {
      key: string;
      details: { capacity?: number };
    }[]
  ).map((c) => [c.key, c.details.capacity]);

describe("rdw", () => {
  test("RDW: specs win over geo counts and a garage that is also P+R keeps one site", () => {
    const garageAsPr = json([
      {
        areamanagerid: "100",
        areaid: "G1",
        areadesc: "Centrum Garage P+R",
        location: { latitude: "52.371", longitude: "4.891" },
        usageid: "PARKRIDE",
      },
    ]);
    const out = parse(
      [fixture("rdw-nl-specs.json")],
      [fixture("rdw-nl-garage.json"), garageAsPr, fixture("rdw-nl-pnr.json")],
    );
    expect(out.features.filter((f) => String(f["id"]).endsWith(":100/G1"))).toHaveLength(1);
    expect(site(out, "100/G1")).toMatchObject({
      type: "off_street",
      name: [{ lang: "nl", text: "Centrum Garage" }],
      location: { geometry: { coordinates: [4.89, 52.37] } },
      // The specifications' 320 and 2.00 m, not the area dataset's 300 and 1.95 m.
      details: { capacityTotal: 320, heightLimit: { value: 2, unit: "m" } },
    });
    expect(areas(out, "100/G1")).toEqual([
      ["car:any", 320],
      ["car:ev_charging", undefined],
      ["car:disabled", undefined],
    ]);
    // A specification without an area has no point, so it is no site.
    expect(site(out, "999/X")).toBeUndefined();
    expect(out.observations).toEqual([]);
  });

  test("RDW: P+R and carpool areas are typed by their usage", () => {
    const out = fixtures();
    expect(site(out, "200/P1")).toMatchObject({
      type: "park_and_ride",
      details: { capacityTotal: 120, usage: ["park_and_ride"] },
    });
    expect(site(out, "300/C1")).toMatchObject({
      type: "off_street",
      details: { capacityTotal: 50, usage: ["carpool"], heightLimit: { value: 0.12, unit: "m" } },
    });
  });

  test("RDW: the published 1/0 flags give presence, and a 0 is none", () => {
    const out = parse(
      [
        json([
          {
            areamanagerid: "114",
            areaid: "114_NOORD",
            capacity: "754",
            chargingpointcapacity: "2",
            disabledaccess: "1",
            maximumvehicleheight: "0",
          },
          {
            areamanagerid: "153",
            areaid: "010106",
            capacity: "335",
            chargingpointcapacity: "0",
            disabledaccess: "0",
            maximumvehicleheight: "200",
          },
        ]),
      ],
      [
        json([
          {
            areamanagerid: "114",
            areaid: "114_NOORD",
            location: { latitude: "52.1", longitude: "5.1" },
            areadesc: "Garage Noord",
            usageid: "GARAGEP",
          },
          {
            areamanagerid: "153",
            areaid: "010106",
            location: { latitude: "52.2", longitude: "5.2" },
            areadesc: "Garage Centrum",
            usageid: "GARAGEP",
          },
        ]),
      ],
    );
    expect(areas(out, "114/114_NOORD")).toEqual([
      ["car:any", 754],
      ["car:ev_charging", undefined],
      ["car:disabled", undefined],
    ]);
    expect(site(out, "114/114_NOORD")?.["details"]).not.toHaveProperty("heightLimit");
    expect(areas(out, "153/010106")).toEqual([["car:any", 335]]);
  });
});

describe("rdw skips", () => {
  beforeEach(() => __resetSkips());

  const area = (areaid: string, location: unknown, usageid = "GARAGEP") => ({
    areamanagerid: "100",
    areaid,
    areadesc: `Area ${areaid}`,
    location,
    usageid,
  });

  test("RDW: an area without a point has no geometry; one without an id or a number is malformed", () => {
    const out = parse(
      [json([{ areamanagerid: "100" }])],
      [
        json([
          area("A", undefined),
          area("B", { latitude: "0", longitude: "0" }),
          area("C", { latitude: "north", longitude: "4.89" }),
          { areadesc: "no id", location: { latitude: "52.3", longitude: "4.89" } },
        ]),
      ],
    );
    expect(out.features).toEqual([]);
    // The specification without its id is malformed too.
    expect(drainSkipped(rdwFeed().id)).toEqual({ no_geometry: 2, malformed: 3 });
  });

  test("RDW: a usage it does not know is an unknown value, the site published off-street", () => {
    const out = parse([], [json([area("D", { latitude: "52.3", longitude: "4.89" }, "KISSRIDE")])]);
    expect(site(out, "100/D")).toMatchObject({ type: "off_street" });
    expect(drainSkipped(rdwFeed().id)).toEqual({ unknown_value: 1 });
  });

  test("RDW: the fixtures skip nothing", () => {
    fixtures();
    expect(drainSkipped(rdwFeed().id)).toEqual({});
  });
});
