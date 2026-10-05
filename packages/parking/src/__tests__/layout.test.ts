import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { type ParkingCatalogFeed, parkingMappingSchema } from "../feed-schema.js";
import { parseLayout } from "../formats/layout.js";
import {
  barcelonaFeed,
  baselFeed,
  bnlsFeed,
  braunschweigFeed,
  brusselsFeed,
  copenhagenFeed,
  fixture,
  florenceFeed,
  ghentFeed,
  madridFeed,
  parseContext,
  salzburgFeed,
  viennaFeed,
} from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-05T03:12:30Z";

function parse(feed: ParkingCatalogFeed, file: string): ParseOutput {
  const out = parseLayout(feed, { main: [fixture(file)] }, parseContext(FETCHED));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => String(f["id"]).endsWith(`:${stationId}`));

/** A site's readings as `property → value`. */
function readings(out: ParseOutput, stationId: string): Record<string, unknown> {
  const featureId = site(out, stationId)?.["id"];
  return Object.fromEntries(
    out.observations
      .filter((o) => (o["subject"] as { featureId: string }).featureId === featureId)
      .map((o) => [o["property"], (o["result"] as { value: unknown }).value]),
  );
}

const readingAt = (out: ParseOutput, stationId: string): unknown => {
  const featureId = site(out, stationId)?.["id"];
  const reading = out.observations.find(
    (o) => (o["subject"] as { featureId: string }).featureId === featureId,
  ) as RecordDraft | undefined;
  return (reading?.["phenomenonTime"] as { instant: string } | undefined)?.instant;
};

describe("geojson", () => {
  test("Salzburg: '207 (34%)' is 207 free at Vienna local time; 'nicht bekannt' is no reading", () => {
    const out = parse(salzburgFeed(), "salzburg.geojson");
    expect(out.features).toHaveLength(5);
    expect(readings(out, "22101")).toEqual({
      "parking.available": 490,
      "parking.trend": "steady",
    });
    // 5.10.2026 5:11 in Salzburg is 03:11 UTC.
    expect(readingAt(out, "22101")).toBe("2026-10-05T03:11:00Z");
    expect(readings(out, "22163")).toEqual({
      "parking.available": 67,
      "parking.trend": "clearing",
    });
    expect(readings(out, "22151")).toEqual({});
    expect(readings(out, "22158")).toEqual({});
    expect(site(out, "22159")).toMatchObject({
      type: "park_and_ride",
      details: { layout: "surface" },
      name: [{ lang: "de", text: "Park & Ride Süd" }],
    });
    expect(site(out, "22101")).toMatchObject({ type: "off_street" });
  });

  test("Basel's live dataset gives free spaces and capacity per garage", () => {
    const out = parse(baselFeed(), "basel.geojson");
    expect(site(out, "baselparkhauscity")).toMatchObject({
      name: [{ lang: "de", text: "Parkhaus City" }],
      details: {
        capacityTotal: 1114,
        layout: "multi_storey",
        website: "https://www.parkleitsystem-basel.ch/parkhaus/city",
      },
      location: { address: { street: "Schanzenstrasse 48", country: "CH" } },
    });
    expect(readings(out, "baselparkhauscity")).toEqual({
      "parking.available": 1057,
      "parking.status": "open",
    });
    expect(readingAt(out, "baselparkhauscity")).toBe("2026-10-05T03:12:00Z");
    expect(readings(out, "baselparkhausrebgasse")).toMatchObject({ "parking.status": "closed" });
    // Free spaces without a capacity stand; 168 free of 165 is impossible.
    expect(readings(out, "baselparkhauspostbasel")).toEqual({
      "parking.available": 77,
      "parking.status": "closed",
    });
    expect(readings(out, "baselparkhausanfos")).toEqual({ "parking.status": "open" });
  });

  test("Ghent: a temporarily closed garage is closed; an unknown count is no reading", () => {
    const out = parse(ghentFeed(), "ghent.geojson");
    const vrijdagmarkt =
      "https://stad.gent/nl/mobiliteit-openbare-werken/parkeren/parkings-gent/parking-vrijdagmarkt";
    expect(readings(out, vrijdagmarkt)).toEqual({ "parking.status": "closed" });
    const loop = "https://stad.gent/nl/loop/mobiliteit-loop#Parkeerterreinen_Stad_Gent";
    expect(readings(out, loop)).toEqual({ "parking.available": 2489, "parking.status": "open" });
    expect(readingAt(out, loop)).toBe("2026-10-05T03:10:03Z");
    // 93 free of 90 is no reading.
    const dampoort =
      "https://www.belgiantrain.be/nl/station-information/car-or-bike-at-station/b-parking/my-b-parking/gent-dampoort";
    expect(readings(out, dampoort)).toEqual({ "parking.status": "open" });
    expect(site(out, loop)).toMatchObject({
      details: {
        layout: "multi_storey",
        capacityTotal: 2490,
        openingHoursText: [{ lang: "nl", text: "24/7" }],
      },
      operator: { name: [{ lang: "nl", text: "Mobiliteitsbedrijf Gent" }] },
    });
    expect(site(out, loop)?.["access"]).toBeUndefined();
  });

  test("Vienna: a P+R garage is typed park_and_ride and its disabled flag is an area", () => {
    const out = parse(viennaFeed(), "vienna.geojson");
    expect(site(out, "1268")).toMatchObject({ type: "park_and_ride" });
    expect(site(out, "1268")?.["components"]).toBeUndefined();
    expect(site(out, "226")).toMatchObject({
      type: "off_street",
      components: [
        {
          key: "car:disabled",
          kind: "parking_area",
          details: { kind: "parking_area", v: 1, vehicleType: "car", userGroup: "disabled" },
        },
      ],
      location: {
        address: { street: "Hegelgasse 1", postalCode: "1010", city: "Wien", country: "AT" },
      },
      operator: { name: [{ lang: "de", text: "WIPARK Garagen GmbH" }] },
      details: { website: "http://wipark.com" },
    });
    expect(out.observations).toEqual([]);
  });

  test("Brussels: sentinel -999 counts are no area and no height", () => {
    const out = parse(brusselsFeed(), "brussels.geojson");
    expect(site(out, "Albertine Square")).toMatchObject({
      components: [{ key: "car:disabled", details: { capacity: 15 } }],
      details: { capacityTotal: 703, heightLimit: { value: 2, unit: "m" } },
      location: { address: { text: "Place de la Justice, 16 - 1000 Bruxelles", country: "BE" } },
    });
    expect(site(out, "Up-site")?.["components"]).toBeUndefined();
    expect(site(out, "Alhambra")?.["components"]).toBeUndefined();
    expect(site(out, "P+R HEYSEL")).toMatchObject({ type: "park_and_ride" });
  });

  test("Florence: free spaces with their own offset, disabled spaces from a counted phrase", () => {
    const out = parse(florenceFeed(), "florence.geojson");
    expect(readings(out, "1")).toEqual({ "parking.available": 424 });
    expect(readingAt(out, "1")).toBe("2026-10-05T03:10:03.109Z");
    expect(site(out, "9")).toMatchObject({
      components: [{ key: "car:disabled", details: { capacity: 8 } }],
      details: { capacityTotal: 371 },
    });
    expect(
      (site(out, "1")!["details"] as { tariffText: { text: string }[] }).tariffText[0]!.text,
    ).toMatch(/^Tariffa auto/);
  });

  test("Copenhagen: a garage still being built is filtered out; the post district splits", () => {
    const out = parse(copenhagenFeed(), "copenhagen.geojson");
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:dk-84-copenhagen-parking:106",
      "oc:feature:dk-84-copenhagen-parking:8",
      "oc:feature:dk-84-copenhagen-parking:6",
    ]);
    expect(site(out, "8")).toMatchObject({
      details: { layout: "underground", capacityTotal: 92 },
      location: {
        address: { street: "Adelgade", houseNumber: "5", postalCode: "1304", city: "København K" },
      },
    });
    expect(
      (site(out, "106")!["details"] as Record<string, unknown>)["capacityTotal"],
    ).toBeUndefined();
  });

  test("Braunschweig (disabled, still parsed): occupied and free counts, status and trend", () => {
    const out = parse(braunschweigFeed(), "braunschweig.geojson");
    const eiermarkt = "2605832cf112cb970b3af61a2266c3e553e7ae";
    expect(readings(out, eiermarkt)).toEqual({
      "parking.available": 486,
      "parking.occupied": 14,
      "parking.status": "open",
      "parking.trend": "steady",
    });
    expect(readings(out, "2605823b1c49c8a9740ccce9895e8f8bac76e9")).toMatchObject({
      "parking.status": "closed",
    });
    expect(readings(out, "260580365a948d771e7406382925d0a5920a81")).toEqual({});
  });
});

describe("json", () => {
  test("Barcelona: [lat, lon] geometry and the street address", () => {
    const out = parse(barcelonaFeed(), "barcelona.json");
    expect(out.features).toHaveLength(3);
    expect(site(out, "93291124550")).toMatchObject({
      name: [{ lang: "ca", text: "Aparcament Cardenal Reig" }],
      location: {
        geometry: { type: "Point", coordinates: [2.1134828061272373, 41.37628120603343] },
        address: {
          street: "C Cardenal Reig",
          houseNumber: "1",
          postalCode: "08028",
          city: "BARCELONA",
          country: "ES",
        },
      },
    });
    const noNumber = site(out, "99327130927")?.["location"] as { address: Record<string, unknown> };
    expect(noNumber.address["houseNumber"]).toBeUndefined();
  });
});

describe("csv", () => {
  test("Madrid CSV: capacity from 'Plazas: N' text, latin1 decoded", () => {
    const out = parse(madridFeed(), "madrid.csv");
    expect(out.features).toHaveLength(4);
    expect(site(out, "11483771")).toMatchObject({
      type: "park_and_ride",
      name: [{ lang: "es", text: "Aparcamiento disuasorio Aviación Española" }],
      details: { capacityTotal: 344 },
      location: { geometry: { coordinates: [-3.783621006318095, 40.38323792632855] } },
    });
    expect(site(out, "13469")).toMatchObject({
      type: "off_street",
      details: { capacityTotal: 482 },
    });
  });

  test("BNLS: hourly costs become a parking_rate offer; is_free=1 is free", () => {
    const out = parse(bnlsFeed(), "bnls.csv");
    expect(
      out.offers.find((o) => o["id"] === "oc:offer:fr-bnls-parking:06027-P-001:1"),
    ).toMatchObject({
      currency: "EUR",
      elements: [
        {
          components: [{ type: "flat", price: { amount: "2.00", currency: "EUR" } }],
          restrictions: { maxDuration: { value: 1, unit: "h" } },
        },
        {
          components: [{ price: { amount: "3.60" } }],
          restrictions: { maxDuration: { value: 2, unit: "h" } },
        },
        {
          components: [{ price: { amount: "5.20" } }],
          restrictions: { maxDuration: { value: 3, unit: "h" } },
        },
        {
          components: [{ price: { amount: "6.80" } }],
          restrictions: { maxDuration: { value: 4, unit: "h" } },
        },
        {
          components: [{ price: { amount: "27.20" } }],
          restrictions: { maxDuration: { value: 24, unit: "h" } },
        },
      ],
    });
    // gratuit=1 marks a free car park.
    expect(site(out, "38039-P-001")?.["access"]).toEqual({
      audience: "unknown",
      payment: ["free"],
    });
    expect(site(out, "06027-P-001")?.["access"]).toBeUndefined();
    expect(site(out, "38039-P-001")).toMatchObject({
      details: { capacityTotal: 22, heightLimit: { value: 2.2, unit: "m" }, layout: "surface" },
    });
    expect(
      (site(out, "06088-P-013")!["components"] as { key: string }[]).map((c) => c.key),
    ).toEqual(["car:disabled", "car:ev_charging", "car:car_sharing"]);
  });
});

describe("parseLayout", () => {
  test("a record without a placeable point or an id is rejected", () => {
    const payload = Buffer.from(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: null, properties: { id: "a", total: 3 } },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [7.5, 47.5] },
            properties: {},
          },
        ],
      }),
    );
    const out = parseLayout(baselFeed(), { main: [payload] }, parseContext(FETCHED));
    expect(out.features).toEqual([]);
    expect(out.rejected).toBe(2);
  });

  /** Basel's mapping over one garage whose `published` time is `published`. */
  function baselAt(published: unknown, free: unknown = 12): Record<string, unknown> {
    const payload = Buffer.from(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [7.59, 47.55] },
            properties: { id: "p1", title: "P1", total: 100, free, published },
          },
        ],
      }),
    );
    const out = parseLayout(baselFeed(), { main: [payload] }, parseContext(FETCHED));
    return { at: readingAt(out, "p1"), ...readings(out, "p1") };
  }

  test("a time with an offset is taken as given; a time without one is in the mapping's zone", () => {
    expect(baselAt("2026-10-05T05:12:00+02:00")).toMatchObject({ at: "2026-10-05T03:12:00Z" });
    // Basel's zone is Europe/Zurich: 05:12 in summer time is 03:12 UTC.
    expect(baselAt("2026-10-05 05:12")).toMatchObject({ at: "2026-10-05T03:12:00Z" });
  });

  test("an unreadable or missing time gives no reading, never the poll's time", () => {
    // A string the server's local Date.parse would read in its own zone.
    expect(baselAt("Mon Oct 05 2026 05:12:00")).toEqual({ at: undefined });
    expect(baselAt("05.10.2026 05:12")).toEqual({ at: undefined });
    expect(baselAt(undefined)).toEqual({ at: undefined });
  });

  test("a published 0 free is a reading of 0", () => {
    expect(baselAt("2026-10-05T03:12:00Z", 0)).toEqual({
      at: "2026-10-05T03:12:00Z",
      "parking.available": 0,
    });
  });

  test("a feed's update time needs its zone", () => {
    const feed = baselFeed();
    const { timezone: _zone, ...updated } = feed.parking!.updated!;
    expect(parkingMappingSchema.safeParse({ ...feed.parking, updated }).success).toBe(false);
    expect(parkingMappingSchema.safeParse(feed.parking).success).toBe(true);
  });

  test("a feed without a parking mapping cannot be parsed", () => {
    const { parking: _parking, ...unmapped } = baselFeed();
    expect(() =>
      parseLayout(
        unmapped as ParkingCatalogFeed,
        { main: [fixture("basel.geojson")] },
        parseContext(FETCHED),
      ),
    ).toThrow(/parking mapping/);
  });
});
