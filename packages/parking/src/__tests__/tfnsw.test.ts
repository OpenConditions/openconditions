import type { ParseOutput } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { parseTfnsw } from "../formats/tfnsw.js";
import { fixture, parseContext, tfnswFeed } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2024-11-25T00:10:00Z";

function parse(body: Buffer): ParseOutput {
  const out = parseTfnsw(tfnswFeed(), { main: [body] }, parseContext(FETCHED));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const fullList = () => parse(fixture("tfnsw-full-list.json"));

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => f["id"] === `oc:feature:au-nsw-tfnsw-parking:${stationId}`);

/** `[property, area key or "site", value]` of each reading of a site. */
const readings = (out: ParseOutput, stationId: string) =>
  out.observations
    .filter(
      (o) => (o["subject"] as { featureId: string }).featureId === site(out, stationId)?.["id"],
    )
    .map((o) => [
      o["property"],
      (o["subject"] as { componentKey?: string }).componentKey ?? "site",
      (o["result"] as { value: unknown }).value,
    ]);

const areas = (out: ParseOutput, stationId: string) =>
  (
    (site(out, stationId)?.["components"] ?? []) as {
      key: string;
      details: { capacity?: number };
    }[]
  ).map((c) => [c.key, c.details.capacity]);

/** A facility of the documented shape, with the given zones. */
const facility = (zones: unknown[]) => ({
  tsn: "2155384",
  spots: "455",
  zones,
  location: {
    suburb: "Tallawong",
    address: "Conferta Avenue",
    latitude: "-33.69",
    longitude: "150.90",
  },
  occupancy: { loop: null, total: "100", monthlies: null, open_gate: null, transients: null },
  MessageDate: "2024-11-25T11:08:35+11:00",
  facility_id: "27",
  facility_name: "Park&Ride - Tallawong P2",
});

const zone = (zoneId: string, zoneName: string, spots: string, total: string) => ({
  spots,
  zone_id: zoneId,
  occupancy: { loop: null, total, monthlies: null, open_gate: null, transients: null },
  zone_name: zoneName,
  parent_zone_id: "0",
});

describe("tfnsw", () => {
  test("TfNSW: MessageDate without a zone is Sydney time", () => {
    const out = fullList();
    const at = (stationId: string) =>
      out.observations.find(
        (o) => (o["subject"] as { featureId: string }).featureId === site(out, stationId)?.["id"],
      )?.["phenomenonTime"];
    // November is daylight saving time (UTC+11), July standard time (UTC+10).
    expect(at("26")).toEqual({ instant: "2024-11-25T00:08:35Z" });
    expect(at("22")).toEqual({ instant: "2024-06-30T22:00:00Z" });
    // A time with an offset is taken as given.
    expect(parse(json([facility([])])).observations[0]?.["phenomenonTime"]).toEqual({
      instant: "2024-11-25T00:08:35Z",
    });
    // Fractional seconds on a Sydney wall-clock time are kept.
    const fractional = parse(json([{ ...facility([]), MessageDate: "2024-11-25T11:08:35.250" }]));
    expect(fractional.observations[0]?.["phenomenonTime"]).toEqual({
      instant: "2024-11-25T00:08:35.250Z",
    });
  });

  test("TfNSW: free spaces are the spots less the vehicles counted, at least 0", () => {
    const out = fullList();
    expect(readings(out, "26")).toEqual([
      ["parking.available", "site", 48],
      ["parking.occupied", "site", 75],
    ]);
    expect(readings(out, "486")).toEqual([
      ["parking.available", "site", 25],
      ["parking.occupied", "site", 200],
    ]);
    // 1,150 vehicles counted in 1,144 spots.
    expect(readings(out, "22")).toEqual([
      ["parking.available", "site", 0],
      ["parking.occupied", "site", 1150],
    ]);
  });

  test("TfNSW: a facility of 0 spots has no capacity, so no free count is derived", () => {
    const out = parse(json([{ ...facility([]), spots: "0" }]));
    expect(readings(out, "27")).toEqual([["parking.occupied", "site", 100]]);
    expect(site(out, "27")?.["details"]).not.toHaveProperty("capacityTotal");
  });

  test("TfNSW: each entry is a park-and-ride site at its location", () => {
    const out = fullList();
    expect(out.features).toHaveLength(3);
    expect(site(out, "26")).toMatchObject({
      type: "park_and_ride",
      name: [{ lang: "en", text: "Park&Ride - Tallawong P1" }],
      location: {
        geometry: { coordinates: [150.9052577, -33.69304704] },
        address: { street: "Conferta Avenue", city: "Tallawong", country: "AU" },
      },
      details: { capacityTotal: 123, usage: ["park_and_ride"] },
    });
    // Without a location there is no point: OpenMapX's table of points is not carried over.
    const unplaced = parse(json([{ ...facility([]), location: { suburb: "Tallawong" } }]));
    expect(unplaced.features).toEqual([]);
    expect(unplaced.rejected).toBe(1);
  });

  test("TfNSW: zones are no areas and give no readings", () => {
    // The documented single zone is the car park itself.
    expect(areas(fullList(), "26")).toEqual([]);
    const zoned = parse(
      json([
        facility([
          zone("27", "SYD397 Tallawong P2 Car Park", "455", "100"),
          zone("2", "Motorcycle bays", "12", "5"),
        ]),
      ]),
    );
    expect(areas(zoned, "27")).toEqual([]);
    expect(readings(zoned, "27")).toEqual([
      ["parking.available", "site", 355],
      ["parking.occupied", "site", 100],
    ]);
  });
});
