import type { ParseOutput } from "@openconditions/ingest-framework";
import { type LinkableFeature, proposeLink } from "@openconditions/model";
import { PARKING_KINDS } from "@openconditions/model-parking";
import { describe, expect, test } from "vitest";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { parseDatex2Light, repairMojibake, upstreamPrefix } from "../formats/datex2-light.js";
import {
  fixture,
  mobidromFeed,
  mobidromParkrideFeed,
  parseContext,
} from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-05T03:30:40Z";

function parse(feed: ParkingCatalogFeed, body: Buffer): ParseOutput {
  const out = parseDatex2Light(feed, { main: [body] }, parseContext(FETCHED));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const nrw = () => parse(mobidromFeed(), fixture("mobidrom-parken-nrw.json"));
const parkride = () => parse(mobidromParkrideFeed(), fixture("mobidrom-parkride.json"));

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => String(f["id"]).endsWith(`:${stationId}`));

function readings(out: ParseOutput, stationId: string): Record<string, unknown> {
  const featureId = site(out, stationId)?.["id"];
  return Object.fromEntries(
    out.observations
      .filter((o) => (o["subject"] as { featureId: string }).featureId === featureId)
      .map((o) => [o["property"], (o["result"] as { value: unknown }).value]),
  );
}

const areas = (out: ParseOutput, stationId: string) =>
  (
    (site(out, stationId)?.["components"] ?? []) as {
      key: string;
      details: { capacity?: number };
    }[]
  ).map((c) => [c.key, c.details.capacity]);

/** One site bean, written as the exporter writes it. */
const bean = (fields: Record<string, unknown>) => ({
  id: "test-1",
  type: "other",
  name: "Testplatz",
  locationAndDimension: { coordinatesForDisplay: { latitude: 51.5, longitude: 7.4 } },
  ...fields,
});

const RULES = PARKING_KINDS.find((k) => k.code === "parking_site")!.linking!;

describe("datex2-light", () => {
  test("DATEX Light: an upstream system's id prefix is its own authority", () => {
    // Düsseldorf's city system and APCOA list one garage 10 m apart; two APCOA garages too.
    const at = (lat: number) => ({
      locationAndDimension: { coordinatesForDisplay: { latitude: lat, longitude: 6.78 } },
    });
    const body = Buffer.from(
      JSON.stringify([
        bean({ id: "16[PH 16 - Japan-Center]", name: "PH 16 - Japan-Center", ...at(51.22) }),
        bean({
          id: "parking-apcoa-4623",
          name: "Düsseldorf, Japan-Center",
          ...at(51.22 + 10 / 111_320),
        }),
        bean({ id: "parking-apcoa-4624", name: "Japan-Center Nord", ...at(51.22 + 20 / 111_320) }),
      ]),
    );
    const out = parse(mobidromFeed(), body);
    const ids = (id: string) => (site(out, id)?.["externalIds"] as unknown[]) ?? [];
    expect(ids("16[PH 16 - Japan-Center]")).toEqual([
      { scheme: "provider", id: "16[PH 16 - Japan-Center]", authority: "de-nw-mobidrom-parking" },
    ]);
    expect(ids("parking-apcoa-4623")).toEqual([
      {
        scheme: "provider",
        id: "parking-apcoa-4623",
        authority: "de-nw-mobidrom-parking/parking-apcoa",
      },
    ]);
    const [city, apcoa, other] = out.features as unknown as LinkableFeature[];
    expect(proposeLink(city!, apcoa!, RULES)).toMatchObject({ status: "accepted" });
    expect(proposeLink(apcoa!, other!, RULES)).toBeUndefined();
  });

  test("DATEX Light: the id prefixes of the bundle's systems", () => {
    expect(
      [
        "parking-parking-spaces-bielefeld-8528825201403",
        "parking-contipark-de-170800",
        "parking-herne-parkmoeglichkeit.24",
        "park-and-ride-bonn-743457",
        "W_P08o",
        "PH01",
        "32[Stadthalle]",
      ].map(upstreamPrefix),
    ).toEqual([
      "parking-parking-spaces-bielefeld",
      "parking-contipark-de",
      "parking-herne-parkmoeglichkeit",
      "park-and-ride-bonn",
      "W",
      "PH",
      "",
    ]);
  });

  test("DATEX Light: double-encoded UTF-8 names are repaired", () => {
    const out = parkride();
    expect(site(out, "park-and-ride-bonn-743457")).toMatchObject({
      name: [{ lang: "de", text: "Tannenbusch-Süd" }],
      location: { address: { text: "Hohe Straße, Bonn", country: "DE" } },
    });
    expect(repairMojibake("TemporÃ¤rer Park & Ride")).toBe("Temporärer Park & Ride");
    // Text that is not double-encoded, or that a byte reading cannot repair, stays.
    expect(repairMojibake("Bottrop-Süd")).toBe("Bottrop-Süd");
    expect(repairMojibake("Ã la carte 🚗")).toBe("Ã la carte 🚗");
  });

  test("DATEX Light: a P+R zone makes a park_and_ride site", () => {
    const zone = parse(
      mobidromFeed(),
      Buffer.from(JSON.stringify([bean({ zoneDescription: ["P+R Hauptbahnhof"] })])),
    );
    expect(site(zone, "test-1")).toMatchObject({
      type: "park_and_ride",
      details: { usage: ["park_and_ride"] },
    });
    // By name, and by the bundle's park-and-ride datasets.
    expect(site(nrw(), "67[P+R Wittlaer Nord]")).toMatchObject({ type: "park_and_ride" });
    expect(site(parkride(), "park-and-ride-bonn-743457")).toMatchObject({ type: "park_and_ride" });
    expect(site(nrw(), "32[Stadthalle]")).toMatchObject({
      type: "off_street",
      details: { layout: "multi_storey" },
    });
  });

  test("DATEX Light: a [lat, lon] record is read the right way round", () => {
    const point = site(parkride(), "park-and-ride-vrr-1201")?.["location"] as {
      geometry: { coordinates: number[] };
    };
    expect(point.geometry.coordinates).toEqual([6.936064, 51.504094]);
    const array = parse(
      mobidromFeed(),
      Buffer.from(
        JSON.stringify([
          bean({
            locationAndDimension: {
              coordinatesForDisplay: { geometry: { type: "Point", coordinates: [51.5, 7.4] } },
            },
          }),
        ]),
      ),
    );
    expect(site(array, "test-1")).toMatchObject({
      location: { geometry: { coordinates: [7.4, 51.5] } },
    });
  });

  test("DATEX Light: free spaces, trend and opening state are readings", () => {
    const out = nrw();
    expect(readings(out, "32[Stadthalle]")).toEqual({
      "parking.available": 0,
      "parking.status": "open",
      "parking.trend": "clearing",
    });
    expect(readings(out, "parking-contipark-de-305200")).toEqual({
      "parking.status": "closed_abnormally",
    });
    const reading = out.observations.find((o) =>
      String((o["subject"] as { featureId: string }).featureId).endsWith(":32[Stadthalle]"),
    );
    expect(reading?.["phenomenonTime"]).toEqual({ instant: "2026-10-05T03:24:54.954Z" });
  });

  test("DATEX Light: assignments are areas, with a count only where one is given", () => {
    const out = nrw();
    expect(areas(out, "32[Stadthalle]")).toEqual([
      ["car:disabled", 2],
      ["car:women", 9],
    ]);
    expect(areas(out, "parking-contipark-de-107700")).toEqual([
      ["car:women", 22],
      ["car:disabled", 9],
      ["car:family", 20],
    ]);
    // A charging assignment without a count, and the equipment list saying so.
    expect(areas(out, "parking-apag-8621")).toEqual([["car:ev_charging", 2]]);
    // A published 0 means none: no women's or family area.
    expect(areas(parkride(), "park-and-ride-vrr-33461")).toEqual([["car:disabled", 3]]);
    // An assignment that gives no count says only that the site has such spaces.
    const stated = parse(
      mobidromFeed(),
      Buffer.from(
        JSON.stringify([
          bean({
            assignedFor: [
              { typeOfAssignment: "onlyFor", user: "disabled" },
              { typeOfAssignment: "onlyFor", user: "women", availableSpaces: 0 },
            ],
          }),
        ]),
      ),
    );
    expect(areas(stated, "test-1")).toEqual([["car:disabled", undefined]]);
  });

  test("DATEX Light: the tariff, opening hours and free flag are kept as published", () => {
    const out = nrw();
    expect(site(out, "32[Stadthalle]")).toMatchObject({
      details: {
        capacityTotal: 125,
        openingHoursText: [
          { lang: "de", text: "MO-DO 0:00-0:00; FR 0:00-0:00; SA 0:00-0:00; SO 0:00-0:00" },
        ],
      },
    });
    expect(site(parkride(), "park-and-ride-bonn-743457")).toMatchObject({
      access: { payment: ["free"] },
    });
    expect(site(out, "parking-apag-8621")).toMatchObject({
      details: { tariffText: [{ lang: "de", text: expect.any(String) }] },
    });
  });
});
