import { observationId } from "@openconditions/model";
import { describe, expect, test } from "vitest";
import { fuelDomain } from "../domain.js";
import { fixture, parseContext, prixCarburantsFeed } from "./helpers/fuel-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * `prix-carburants.json` is a trimmed capture of the live
 * `prix-des-carburants-en-france-flux-instantane-v2` JSON export, fetched
 * 2026-10-03 21:54Z: three of its 9829 stations, without the opening-hours
 * and services fields the parser does not read. Station 89100001 has a
 * definitive stock-out of SP95 and GPLc and an E85 price last updated
 * 2026-08-25; 82800001 has a temporary GPLc stock-out.
 */
const FETCHED = "2026-10-03T21:54:00Z";

type Draft = Record<string, unknown>;

const parse = (payload: Buffer = fixture("prix-carburants.json")) =>
  fuelDomain.formats["prix-carburants"]!.parse(
    prixCarburantsFeed(),
    { main: [payload] },
    parseContext(FETCHED),
  );

const featureId = (id: number) => `oc:feature:fr-prixcarburants-fuel:${id}`;

const readings = (observations: Draft[], id: number, property: string) =>
  new Map(
    observations
      .filter(
        (o) =>
          o["property"] === property &&
          (o["subject"] as { featureId: string }).featureId === featureId(id),
      )
      .map((o) => [(o["subject"] as { componentKey: string }).componentKey, o]),
  );

/** The fixture with one station's fields replaced. */
function patched(id: number, fields: Record<string, unknown>): Buffer {
  const stations = JSON.parse(fixture("prix-carburants.json").toString("utf8")) as Draft[];
  for (const s of stations) if (s["id"] === id) Object.assign(s, fields);
  return Buffer.from(JSON.stringify(stations));
}

describe("prix-carburants", () => {
  test("prix-carburants keeps each grade's own update time", () => {
    const { observations } = parse();
    const prices = readings(observations, 89100001, "fuel.price");
    // The export labels the publisher's Paris wall-clock times +00:00.
    expect(prices.get("diesel")!["phenomenonTime"]).toEqual({ instant: "2026-09-28T09:45:27Z" });
    expect(prices.get("sp98")!["phenomenonTime"]).toEqual({ instant: "2026-09-28T09:42:00Z" });
    // A price over a month old is still that price, at its own time.
    expect(prices.get("e85")!["phenomenonTime"]).toEqual({ instant: "2026-08-25T08:02:31Z" });
    expect(prices.get("diesel")!["result"]).toEqual({
      type: "money",
      amount: "2.429",
      currency: "EUR",
      per: "L",
    });
    for (const o of prices.values()) {
      expect(o["id"]).toBe(observationId("fr-prixcarburants-fuel", o as never));
    }
  });

  test("a prix-carburants rupture is a product that is not available, with no price", () => {
    const { features, observations } = parse();
    const negrepelisse = features.find((f) => f["id"] === featureId(82800001))!;
    expect((negrepelisse["components"] as { key: string }[]).map((c) => c.key)).toContain("lpg");
    expect(readings(observations, 82800001, "fuel.price").has("lpg")).toBe(false);
    const available = readings(observations, 82800001, "fuel.product_available");
    expect(available.get("lpg")!["result"]).toEqual({ type: "boolean", value: false });
    expect(available.get("diesel")!["result"]).toEqual({ type: "boolean", value: true });
    expect(available.get("lpg")!["phenomenonTime"]).toEqual({ instant: FETCHED });

    // A definitive stock-out reads the same.
    const sens = readings(observations, 89100001, "fuel.product_available");
    expect(sens.get("e5")!["result"]).toEqual({ type: "boolean", value: false });
    expect(readings(observations, 89100001, "fuel.price").has("e5")).toBe(false);
  });

  test("maps the six grades the ministry prices", () => {
    const { features } = parse();
    const tignieu = features.find((f) => f["id"] === featureId(38230003))!;
    expect((tignieu["components"] as { key: string }[]).map((c) => c.key)).toEqual([
      "diesel",
      "e5",
      "e10",
      "sp98",
      "e85",
      "lpg",
    ]);
    expect(tignieu["details"]).toEqual({ kind: "fuel_station", v: 1, productsComplete: true });
    expect(tignieu["location"]).toMatchObject({
      geometry: { type: "Point", coordinates: [5.183, 45.745] },
      admin: { country: "FR", geocodes: [{ scheme: "iso3166-2", code: "FR-38" }] },
      address: {
        street: "Rue des Ardennes",
        postalCode: "38230",
        city: "Tignieu-Jameyzieu",
        country: "FR",
      },
    });
  });

  test("a missing or non-positive price is no reading", () => {
    const { observations } = parse(patched(38230003, { gazole_prix: 0, sp95_prix: null }));
    const prices = readings(observations, 38230003, "fuel.price");
    expect(prices.has("diesel")).toBe(false);
    expect(prices.has("e5")).toBe(false);
    expect(prices.has("e10")).toBe(true);
  });

  test("a price without a readable update time is no reading", () => {
    const { observations } = parse(
      patched(38230003, { gazole_maj: null, sp95_maj: "yesterday", e10_maj: "" }),
    );
    const prices = readings(observations, 38230003, "fuel.price");
    expect(prices.has("diesel")).toBe(false);
    expect(prices.has("e5")).toBe(false);
    expect(prices.has("e10")).toBe(false);
    expect(prices.has("sp98")).toBe(true);
    // The grade is still sold and in stock.
    expect(readings(observations, 38230003, "fuel.product_available").get("diesel")).toBeDefined();
  });

  test("an update time with fractional seconds is still Paris time; another offset is kept", () => {
    const { observations } = parse(
      patched(38230003, {
        gazole_maj: "2026-10-03T09:29:00.000+00:00",
        sp95_maj: "2026-10-03T09:29:00+01:00",
      }),
    );
    const prices = readings(observations, 38230003, "fuel.price");
    expect(prices.get("diesel")!["phenomenonTime"]).toEqual({ instant: "2026-10-03T07:29:00Z" });
    expect(prices.get("e5")!["phenomenonTime"]).toEqual({ instant: "2026-10-03T08:29:00Z" });
  });

  test("a station at 0,0 is skipped", () => {
    const out = parse(patched(38230003, { geom: { lon: 0, lat: 0 } }));
    expect(out.features.map((f) => f["id"])).not.toContain(featureId(38230003));
    expect(out.rejected).toBe(1);
    const outside = parse(patched(38230003, { geom: { lon: 5.183, lat: 145.745 } }));
    expect(outside.features).toHaveLength(2);
    expect(outside.rejected).toBe(1);
  });

  test("every drafted record seals", () => {
    const { features, observations } = parse();
    expect(features).toHaveLength(3);
    expect(sealFailures([...features, ...observations])).toEqual([]);
  });
});
