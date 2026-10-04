import { observationId } from "@openconditions/model";
import { describe, expect, test } from "vitest";
import { fuelDomain } from "../domain.js";
import { fixture, parseContext, tankerkoenigFeed } from "./helpers/fuel-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * `tankerkoenig-list.json` is the radius search the Tankerkönig API
 * documentation links as its example (creativecommons.tankerkoenig.de, demo key
 * 00000000-0000-0000-0000-000000000002), fetched 2026-10-04: two Berlin
 * stations, CC BY 4.0 Tankerkönig (MTS-K). A third station, 60c0eefa, is added
 * by hand after the documentation's price example: no E5 (`false`, the
 * station does not sell it) and an E10 price of `null` (no price known).
 */
const FETCHED = "2026-10-04T01:26:00Z";
const EXPIRES = "2026-10-04T01:41:00Z";

type Draft = Record<string, unknown>;

const parse = (payload: Buffer = fixture("tankerkoenig-list.json")) =>
  fuelDomain.formats["tankerkoenig"]!.parse(
    tankerkoenigFeed(),
    { main: [payload] },
    parseContext(FETCHED),
  );

const featureId = (id: string) => `oc:feature:de-tankerkoenig-fuel:${id}`;
const TOTAL = "474e5046-deaf-4f9b-9a32-9797b778f047";
const DIESEL_ONLY = "60c0eefa-d2a8-4f5c-82cc-b5244ecae955";

const readings = (observations: Draft[], id: string, property: string) =>
  new Map(
    observations
      .filter(
        (o) =>
          o["property"] === property &&
          (o["subject"] as { featureId: string }).featureId === featureId(id),
      )
      .map((o) => [(o["subject"] as { componentKey: string }).componentKey, o]),
  );

const keys = (feature: Draft | undefined) =>
  (feature?.["components"] as { key: string }[] | undefined)?.map((c) => c.key);

describe("tankerkoenig", () => {
  test("a Tankerkönig price of false is a grade the station does not sell; null is unknown", () => {
    const { features, observations } = parse();
    const station = features.find((f) => f["id"] === featureId(DIESEL_ONLY));
    // e5 is a product, known not to be on sale; e10 is not known at all.
    expect(keys(station)).toEqual(["e5", "diesel"]);
    const available = readings(observations, DIESEL_ONLY, "fuel.product_available");
    expect(available.get("e5")!["result"]).toEqual({ type: "boolean", value: false });
    expect(available.has("e10")).toBe(false);
    const prices = readings(observations, DIESEL_ONLY, "fuel.price");
    expect([...prices.keys()]).toEqual(["diesel"]);
    expect(prices.get("diesel")!["result"]).toEqual({
      type: "money",
      amount: "1.189",
      currency: "EUR",
      per: "L",
    });
  });

  test("prices E5, E10 and diesel as of the fetch, which lists no grade beyond them", () => {
    const { features, observations } = parse();
    const total = features.find((f) => f["id"] === featureId(TOTAL))!;
    expect(keys(total)).toEqual(["e5", "e10", "diesel"]);
    expect(total["details"]).toEqual({
      kind: "fuel_station",
      v: 1,
      brand: "TotalEnergies",
      productsComplete: false,
    });
    expect(total["name"]).toEqual([{ lang: "de", text: "TotalEnergies Berlin" }]);
    expect(total["location"]).toMatchObject({
      geometry: { type: "Point", coordinates: [13.440946, 52.530831] },
      address: {
        street: "Margarete-Sommer-Str.",
        houseNumber: "2",
        postalCode: "10407",
        city: "Berlin",
        country: "DE",
      },
      admin: { country: "DE" },
    });
    expect(total["provenance"]).toMatchObject({
      sourceId: "de-tankerkoenig-fuel",
      sourceFormat: "tankerkoenig",
      accessMode: "on_demand",
      recordId: TOTAL,
    });
    expect(total["freshness"]).toEqual({ fetchedAt: FETCHED, expiresAt: EXPIRES });
    const prices = readings(observations, TOTAL, "fuel.price");
    expect([...prices.keys()]).toEqual(["e5", "e10", "diesel"]);
    for (const price of prices.values()) {
      expect(price["phenomenonTime"]).toEqual({ instant: FETCHED });
      expect(price["id"]).toBe(observationId("de-tankerkoenig-fuel", price as never));
    }
  });

  test("an empty brand is no brand", () => {
    const { features } = parse();
    const station = features.find((f) => f["id"] === featureId(DIESEL_ONLY))!;
    expect(station["details"]).toEqual({ kind: "fuel_station", v: 1, productsComplete: false });
    expect((station["location"] as Draft)["address"]).toEqual({
      street: "Landsberger Allee",
      postalCode: "10365",
      city: "Berlin",
      country: "DE",
    });
  });

  test("an integer postcode keeps its leading zero", () => {
    const answer = JSON.parse(fixture("tankerkoenig-list.json").toString("utf8")) as {
      stations: Draft[];
    };
    for (const station of answer.stations) {
      if (station["id"] === TOTAL) Object.assign(station, { postCode: 1067, place: "Dresden" });
    }
    const { features } = parse(Buffer.from(JSON.stringify(answer)));
    const station = features.find((f) => f["id"] === featureId(TOTAL))!;
    expect((station["location"] as Draft)["address"]).toMatchObject({
      postalCode: "01067",
      city: "Dresden",
    });
  });

  test("an answer that is not ok throws with the API's message", () => {
    const refused = Buffer.from(JSON.stringify({ ok: false, message: "apikey nicht angegeben" }));
    expect(() => parse(refused)).toThrow(/tankerkoenig: apikey nicht angegeben/);
  });

  test("every drafted record seals", () => {
    const { features, observations } = parse();
    expect(features).toHaveLength(3);
    expect(sealFailures([...features, ...observations])).toEqual([]);
  });
});
