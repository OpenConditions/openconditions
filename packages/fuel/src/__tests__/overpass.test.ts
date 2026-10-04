import { describe, expect, test } from "vitest";
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
  test("an OSM fuel station's fuel:* tags become products with availability, no prices", () => {
    const { features, observations } = parse();
    const total = station(features, "node/669891011");
    // fuel:GTL_diesel has no grade of its own and is left out.
    expect(
      components(total).map((c) => [c.key, c.details["grade"], c.details["vehicleScope"]]),
    ).toEqual([
      ["diesel", "diesel", "any"],
      ["e5", "e5", "any"],
      ["e10", "e10", "any"],
      ["sp98", "sp98", "any"],
      ["lpg", "lpg", "any"],
      ["diesel:hgv", "diesel", "hgv"],
    ]);
    const available = readings(observations, "node/669891011", "fuel.product_available");
    expect([...available.keys()]).toEqual(["diesel", "e5", "e10", "sp98", "lpg", "diesel:hgv"]);
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
