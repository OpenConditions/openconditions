import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { fuelDomain } from "../domain.js";
import { fixture, osmFuelFeed, parseContext } from "./helpers/fuel-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * `overpass-fuel.json` is the live answer of overpass-api.de to the feed's
 * query for the 0.1° cell 13.4–13.5 E, 52.5–52.6 N (Berlin), fetched
 * 2026-10-04 01:24Z (OSM base 2026-10-03T23:24:31Z): 28 nodes and 10 ways
 * tagged amenity=fuel. © OpenStreetMap contributors, ODbL 1.0.
 */
const FETCHED = "2026-10-04T01:24:00Z";
const EXPIRES = "2026-10-04T02:24:00Z";

type Draft = Record<string, unknown>;

const parse = (payload: Buffer = fixture("overpass-fuel.json")) =>
  fuelDomain.formats["overpass"]!.parse(osmFuelFeed(), { main: [payload] }, parseContext(FETCHED));

const featureId = (element: string) => `oc:feature:osm-fuel:${element}`;
const station = (features: Draft[], element: string) =>
  features.find((f) => f["id"] === featureId(element));

const readings = (observations: Draft[], element: string, property: string) =>
  new Map(
    observations
      .filter(
        (o) =>
          o["property"] === property &&
          (o["subject"] as { featureId: string }).featureId === featureId(element),
      )
      .map((o) => [(o["subject"] as { componentKey: string }).componentKey, o["result"]]),
  );

const components = (feature: Draft | undefined) =>
  (feature?.["components"] as { key: string; details: Draft }[] | undefined) ?? [];

/** The fixture with one element's tags replaced. */
function patched(id: number, tags: Record<string, string | undefined>): Buffer {
  const doc = JSON.parse(fixture("overpass-fuel.json").toString("utf8"));
  for (const e of doc.elements as { id: number; tags: Record<string, string> }[]) {
    if (e.id !== id) continue;
    for (const [k, v] of Object.entries(tags)) {
      if (v === undefined) delete e.tags[k];
      else e.tags[k] = v;
    }
  }
  return Buffer.from(JSON.stringify(doc));
}

describe("overpass", () => {
  test("a node keeps its own position; a way's centre is labelled derived", () => {
    const { features } = parse();
    const origin = (element: string) =>
      (station(features, element)?.["location"] as Draft | undefined)?.["geometryOrigin"];
    expect(origin("node/64707597")).toBe("source");
    expect(origin("way/30051409")).toBe("derived");
  });

  test("an OSM fuel station's fuel:* tags become products with availability, no prices", () => {
    const { features, observations } = parse();
    const total = station(features, "node/669891011");
    // fuel:GTL_diesel is the brand's premium diesel.
    expect(
      components(total).map((c) => [c.key, c.details["grade"], c.details["vehicleScope"]]),
    ).toEqual([
      ["diesel", "diesel", "any"],
      ["e5", "e5", "any"],
      ["e10", "e10", "any"],
      ["sp98", "sp98", "any"],
      ["lpg", "lpg", "any"],
      ["diesel_premium", "diesel_premium", "any"],
      ["diesel:hgv", "diesel", "hgv"],
    ]);
    const available = readings(observations, "node/669891011", "fuel.product_available");
    expect([...available.keys()]).toEqual([
      "diesel",
      "e5",
      "e10",
      "sp98",
      "lpg",
      "diesel_premium",
      "diesel:hgv",
    ]);
    expect(available.get("diesel")).toEqual({ type: "boolean", value: true });
    expect(observations.some((o) => o["property"] === "fuel.price")).toBe(false);

    const unsold = parse(patched(669891011, { "fuel:diesel": "no", "fuel:octane_98": "maybe" }));
    const off = readings(unsold.observations, "node/669891011", "fuel.product_available");
    expect(off.get("diesel")).toEqual({ type: "boolean", value: false });
    // Neither yes nor no says nothing.
    expect(off.has("sp98")).toBe(false);
  });

  test("maps the grades OSM tags name", () => {
    const tags = {
      "fuel:diesel": undefined,
      "fuel:octane_95": undefined,
      "fuel:e10": undefined,
      "fuel:octane_98": undefined,
      "fuel:lpg": undefined,
      "fuel:HGV_diesel": undefined,
      "fuel:GTL_diesel": undefined,
      "fuel:e85": "yes",
      "fuel:cng": "yes",
      "fuel:lng": "yes",
      "fuel:adblue": "yes",
      "fuel:h2": "yes",
      "fuel:hydrogen": "yes",
    };
    const { features } = parse(patched(669891011, tags));
    const total = station(features, "node/669891011");
    expect(components(total).map((c) => [c.key, c.details["per"]])).toEqual([
      ["e85", "L"],
      ["cng", "kg"],
      ["lng", "kg"],
      ["adblue", "L"],
      ["h2_700", "kg"],
    ]);
  });

  test("maps the renewable, gas, 100 octane and alias tags the fixture carries", () => {
    const { features } = parse();
    const keys = (element: string) => components(station(features, element)).map((c) => c.key);
    expect(keys("way/1329644964")).toEqual([
      "diesel",
      "e5",
      "e10",
      "sp98",
      "lpg",
      "cng",
      "diesel_premium",
      "diesel:hgv",
      "b100",
      "hvo100",
    ]);
    expect(keys("way/30051409")).toContain("cng_bio");
    expect(keys("node/308811402")).toEqual(["e5", "e10", "sp100", "diesel_premium"]);
    const aliases = parse(
      patched(669891011, {
        "fuel:GNV": "yes",
        "fuel:diesel_b7": "yes",
        "fuel:b10": "no",
        "fuel:h35": "yes",
        "fuel:methanol": "yes",
        "fuel:e100": "yes",
      }),
    );
    expect(
      components(station(aliases.features, "node/669891011")).map((c) => [c.key, c.details["per"]]),
    ).toEqual(
      expect.arrayContaining([
        ["cng", "kg"],
        ["b7", "L"],
        ["b10", "L"],
        ["h2_350", "kg"],
        ["methanol", "L"],
        ["ethanol", "L"],
      ]),
    );
  });

  test("self service, payment, access and amenity tags are read", () => {
    const { features } = parse();
    const aral = station(features, "node/64707597")!;
    expect(new Set(components(aral).map((c) => c.details["service"]))).toEqual(new Set(["self"]));
    expect(aral["access"]).toEqual({
      audience: "unknown",
      payment: ["credit_card", "cash", "other", "debit_card"],
    });
    expect(aral["amenities"]).toEqual(["compressed_air"]);
    // No self_service tag: the service is not known.
    const star = station(features, "node/5338207969")!;
    expect(components(star)[0]!.details["service"]).toBeUndefined();
    expect(star["amenities"]).toEqual(["kiosk", "cash_machine", "compressed_air"]);
    expect(station(features, "node/308811402")!["access"]).toEqual({ audience: "customers" });
    expect(station(features, "node/2886852045")!["amenities"]).toEqual([
      "food_shopping",
      "compressed_air",
    ]);
    expect(station(features, "node/669891011")!["amenities"]).toEqual(["kiosk", "compressed_air"]);
    expect(station(features, "way/225096721")!["amenities"]).toEqual(["compressed_air", "wifi"]);
    expect(station(features, "node/12309549540")!["amenities"]).toEqual([
      "car_wash",
      "compressed_air",
    ]);

    const served = parse(patched(5338207969, { self_service: "no", hgv: "yes", toilets: "yes" }));
    const attended = station(served.features, "node/5338207969")!;
    expect(new Set(components(attended).map((c) => c.details["service"]))).toEqual(
      new Set(["served"]),
    );
    expect((attended["details"] as Draft)["truckSuitable"]).toBe(true);
    expect(attended["amenities"]).toContain("toilets");
  });

  test("an OSM station is identified by its element and carries its tags", () => {
    const { features } = parse();
    const total = station(features, "node/669891011")!;
    expect(total["externalIds"]).toEqual([{ scheme: "osm:node", id: "669891011" }]);
    expect(total["name"]).toEqual([{ lang: "und", text: "Total Station" }]);
    expect(total["openingHours"]).toEqual({ osm: "24/7", twentyFourSeven: true });
    expect(total["details"]).toEqual({
      kind: "fuel_station",
      v: 1,
      brand: "TotalEnergies",
      brandWikidata: "Q154037",
      productsComplete: false,
    });
    expect(total["provenance"]).toMatchObject({
      recordId: "node/669891011",
      accessMode: "on_demand",
    });
    expect(total["freshness"]).toEqual({ fetchedAt: FETCHED, expiresAt: EXPIRES });

    const shell = station(features, "node/281775191")!;
    expect(shell["operator"]).toEqual({ role: "operator", name: [{ lang: "und", text: "Shell" }] });
    expect(shell["openingHours"]).toEqual({ osm: "Mo-Su 06:00-22:00" });

    // A way is placed at its centre; its address names its country.
    const star = station(features, "way/30051409")!;
    expect(star["externalIds"]).toEqual([{ scheme: "osm:way", id: "30051409" }]);
    expect(star["location"]).toMatchObject({
      geometry: { type: "Point", coordinates: [13.428834, 52.5687487] },
      address: {
        street: "Prenzlauer Promenade",
        houseNumber: "70-73",
        postalCode: "13089",
        city: "Berlin",
        country: "DE",
      },
    });
    // Without addr:country an address cannot be placed in a country.
    expect((total["location"] as Draft)["address"]).toBeUndefined();
  });

  test("a brand:wikidata that names no Wikidata item is left out", () => {
    const { features } = parse(patched(669891011, { "brand:wikidata": "TotalEnergies" }));
    const total = station(features, "node/669891011")!;
    expect(total["details"]).toEqual({
      kind: "fuel_station",
      v: 1,
      brand: "TotalEnergies",
      productsComplete: false,
    });
  });

  test("a station without fuel:* tags has no products", () => {
    const { features } = parse();
    const total = station(features, "node/101387833")!;
    expect(total["components"]).toBeUndefined();
  });

  test("every drafted record seals", () => {
    const { features, observations } = parse();
    expect(features).toHaveLength(38);
    expect(sealFailures([...features, ...observations])).toEqual([]);
  });

  test("an Overpass runtime error fails the parse", () => {
    const error = Buffer.from(JSON.stringify({ elements: [], remark: "runtime error: timeout" }));
    expect(() => parse(error)).toThrow(/runtime error/);
  });
});

describe("skips", () => {
  beforeEach(() => __resetSkips());

  test("the fixture's fuels without a grade and values neither yes nor no are counted", () => {
    // fuel:octane_102 and fuel:gts_diesel name no grade; one fuel:GTL_diesel is "1".
    parse();
    expect(drainSkipped(osmFuelFeed().id)).toEqual({ unknown_value: 3 });
  });

  test("fuel:others names no product; an unknown access or payment value is counted", () => {
    parse(
      patched(669891011, {
        "fuel:GTL_diesel": undefined,
        "fuel:others": "no",
        access: "destination",
        "payment:cash": "only",
      }),
    );
    expect(drainSkipped(osmFuelFeed().id)).toEqual({ unknown_value: 5 });
  });

  test("a station without a position or outside WGS84 range is skipped", () => {
    const { features, rejected } = parse(
      Buffer.from(
        JSON.stringify({
          elements: [
            { type: "way", id: 1, tags: { amenity: "fuel" } },
            { type: "node", id: 2, lat: 95, lon: 8, tags: { amenity: "fuel" } },
            { type: "node", id: 3, lat: 49, lon: 8, tags: { amenity: "fuel" } },
          ],
        }),
      ),
    );
    expect(features).toHaveLength(1);
    expect(rejected ?? 0).toBe(0);
    expect(drainSkipped(osmFuelFeed().id)).toEqual({ no_geometry: 1, malformed: 1 });
  });
});
