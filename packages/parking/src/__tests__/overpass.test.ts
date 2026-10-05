import type { ParseOutput } from "@openconditions/ingest-framework";
import { type LinkableFeature, proposeLink } from "@openconditions/model";
import { PARKING_KINDS } from "@openconditions/model-parking";
import { describe, expect, test } from "vitest";
import { parseOverpassParking } from "../formats/overpass.js";
import { fixture, osmParkingFeed, parseContext } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-05T03:43:24Z";

function parse(body: Buffer): ParseOutput {
  const out = parseOverpassParking(osmParkingFeed(), { main: [body] }, parseContext(FETCHED));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const osm = () => parse(fixture("overpass-parking.json"));

const site = (out: ParseOutput, element: string) =>
  out.features.find((f) => f["id"] === `oc:feature:osm-parking:${element}`);

const areas = (out: ParseOutput, element: string) =>
  (
    (site(out, element)?.["components"] ?? []) as { key: string; details: { capacity?: number } }[]
  ).map((c) => [c.key, c.details.capacity]);

const RULES = PARKING_KINDS.find((k) => k.code === "parking_site")!.linking!;

describe("overpass", () => {
  test("Overpass: a node and a way of one car park 15 m apart link; two ways do not", () => {
    const lat = 49.0089787;
    const lon = 8.4015944;
    const element = (type: string, id: number, dLatM: number) => ({
      type,
      id,
      ...(type === "node"
        ? { lat: lat + dLatM / 111_320, lon }
        : { center: { lat: lat + dLatM / 111_320, lon } }),
      tags: { amenity: "parking", name: "Friedrichsplatz", parking: "underground" },
    });
    const out = parse(
      Buffer.from(
        JSON.stringify({
          elements: [element("node", 1, 0), element("way", 2, 15), element("way", 3, 30)],
        }),
      ),
    );
    const [node, way, other] = out.features as unknown as LinkableFeature[];
    expect(proposeLink(node!, way!, RULES)).toMatchObject({ status: "accepted" });
    // Two ways are two elements: `osm:way` 2 and 3 conflict.
    expect(proposeLink(way!, other!, RULES)).toBeUndefined();
  });

  test("Overpass: street-side parking is on_street and capacity:disabled an area", () => {
    const out = osm();
    expect(site(out, "node/1336906453")).toMatchObject({
      type: "on_street",
      // Its OSM id is its only id: a provider id would keep the node, way and
      // relation of one car park from linking.
      externalIds: [{ scheme: "osm:node", id: "1336906453" }],
      access: { audience: "customers", payment: ["free"] },
      details: { capacityTotal: 2 },
    });
    expect(areas(out, "node/1336906453")).toEqual([["car:disabled", 2]]);
  });

  test("Overpass: a multi-storey car park keeps its tags as a site", () => {
    const out = osm();
    expect(site(out, "node/1725394191")).toMatchObject({
      type: "off_street",
      name: [{ lang: "und", text: "Karstadt" }],
      operator: { role: "operator", name: [{ lang: "und", text: "Karstadt Warenhaus AG" }] },
      openingHours: { osm: "Mo-Su 00:00-23:59" },
      access: { audience: "public" },
      location: {
        address: {
          street: "Zähringerstraße",
          houseNumber: "69",
          postalCode: "76133",
          city: "Karlsruhe",
          country: "DE",
        },
      },
      freshness: { fetchedAt: FETCHED, expiresAt: "2026-10-05T09:43:24Z" },
      details: {
        layout: "multi_storey",
        capacityTotal: 330,
        heightLimit: { value: 2.1, unit: "m" },
      },
    });
    expect(areas(out, "node/1725394191")).toEqual([
      ["car:disabled", 5],
      ["car:women", 20],
    ]);
    expect(out.observations).toEqual([]);
  });

  test("Overpass: park_ride, rooftop and private parking", () => {
    const out = osm();
    expect(site(out, "way/4706466")).toMatchObject({
      type: "park_and_ride",
      location: { geometry: { coordinates: [8.4467181, 49.0257827] } },
      openingHours: { osm: "24/7", twentyFourSeven: true },
      details: { layout: "surface", usage: ["park_and_ride"] },
    });
    expect(site(out, "way/1013819418")).toMatchObject({
      access: { audience: "private" },
      details: { layout: "multi_storey" },
    });
    // A site with no address tags has no address: OSM's region is the world.
    expect(site(out, "node/25308684")?.["location"]).not.toHaveProperty("address");
  });

  test("Overpass: a height in feet or a capacity that is not a count is left out", () => {
    const out = parse(
      Buffer.from(
        JSON.stringify({
          elements: [
            {
              type: "node",
              id: 1,
              lat: 49,
              lon: 8.4,
              tags: {
                amenity: "parking",
                maxheight: "7'6\"",
                capacity: "ca. 20",
                "capacity:charging": "yes",
              },
            },
            { type: "node", id: 2, lat: 49, lon: 8.4, tags: { amenity: "fuel" } },
          ],
        }),
      ),
    );
    expect(out.features).toHaveLength(1);
    expect(site(out, "node/1")?.["details"]).toEqual({ kind: "parking_site", v: 1 });
    expect(areas(out, "node/1")).toEqual([["car:ev_charging", undefined]]);
  });
});
