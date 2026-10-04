import { type LinkableFeature, proposeLink } from "@openconditions/model";
import { FUEL_KINDS } from "@openconditions/model-fuel";
import { describe, expect, test } from "vitest";
import { type FuelFeed, type StationInput, stationDraft } from "../station.js";
import { econtrolFeed, osmFuelFeed } from "./helpers/fuel-feed.js";

const RULES = FUEL_KINDS.find((k) => k.code === "fuel_station")!.linking!;

const FETCHED = "2026-10-04T07:06:27Z";

/** Two BP stations on either side of Triester Straße, Vienna, 100 m apart, as E-Control lists them. */
const NORTH_SIDE: StationInput = {
  stationId: "35755",
  lon: 16.34124,
  lat: 48.15715,
  fetchedAt: FETCHED,
  name: { lang: "de", text: "BP" },
  productsComplete: false,
  products: [],
};
const SOUTH_SIDE: StationInput = { ...NORTH_SIDE, stationId: "35729", lon: 16.3424, lat: 48.1567 };

const linkable = (feed: FuelFeed, input: StationInput) =>
  stationDraft(feed, input) as unknown as LinkableFeature;

describe("stationDraft", () => {
  test("a station carries its source's id under the provider scheme, with the feed as authority", () => {
    expect(stationDraft(econtrolFeed(), SOUTH_SIDE)["externalIds"]).toEqual([
      { scheme: "provider", id: "35729", authority: "at-econtrol-fuel" },
    ]);
  });

  test("a station given ids of its own carries those instead", () => {
    const osm = {
      ...SOUTH_SIDE,
      stationId: "node/1",
      externalIds: [{ scheme: "osm:node", id: "1" }],
    };
    expect(stationDraft(osmFuelFeed(), osm)["externalIds"]).toEqual([
      { scheme: "osm:node", id: "1" },
    ]);
  });

  test("two stations of one source never link, however close and alike", () => {
    const north = linkable(econtrolFeed(), NORTH_SIDE);
    const south = linkable(econtrolFeed(), SOUTH_SIDE);
    expect(proposeLink(north, south, RULES)).toBeUndefined();
  });

  test("a station still links to another source's record of it", () => {
    const osm = {
      ...SOUTH_SIDE,
      stationId: "node/6284882542",
      lon: 16.34169,
      lat: 48.15644,
      externalIds: [{ scheme: "osm:node", id: "6284882542" }],
    };
    expect(
      proposeLink(linkable(econtrolFeed(), SOUTH_SIDE), linkable(osmFuelFeed(), osm), RULES),
    ).toMatchObject({ status: "accepted", method: "spatial_attribute" });
  });
});
