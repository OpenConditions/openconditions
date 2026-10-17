import { __resetSkips, drainSkipped } from "@openconditions/ingest-framework";
import { observationId } from "@openconditions/model";
import { beforeEach, describe, expect, test } from "vitest";
import { fuelDomain } from "../domain.js";
import { fixture, parseContext, prixCarburantsFeed } from "./helpers/fuel-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * `prix-carburants.json` holds five of the 9802 stations of the live
 * `prix-des-carburants-en-france-flux-instantane-v2` JSON export, fetched
 * 2026-10-17 12:25Z, with every field the export carries. 89100001 has
 * definitive ruptures of SP95 and GPLc and an E85 price last updated
 * 2026-10-05; 82800001 a temporary GPLc rupture and E85 unavailable without
 * one; 38230003 and 84550004 (a motorway service area selling natural gas)
 * a card terminal open round the clock; 57580002 counter hours only.
 */
const FETCHED = "2026-10-17T12:25:00Z";

type Draft = Record<string, unknown>;

const parse = (payload: Buffer = fixture("prix-carburants.json")) =>
  fuelDomain.formats["prix-carburants"]!.parse(
    prixCarburantsFeed(),
    { main: [payload] },
    parseContext(FETCHED),
  );

const FEED = "fr-prixcarburants-fuel";

const featureId = (id: number) => `oc:feature:fr-prixcarburants-fuel:${id}`;

const station = (features: Draft[], id: number) => features.find((f) => f["id"] === featureId(id))!;

const keys = (feature: Draft) => (feature["components"] as { key: string }[]).map((c) => c.key);

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

/** A `horaires` value: the given days' entries, Monday first. */
const horaires = (jour: Draft[], automate = "") =>
  JSON.stringify({ "@automate-24-24": automate, jour });

const day = (id: number, entry: Draft): Draft => ({ "@id": String(id), "@ferme": "", ...entry });

describe("prix-carburants", () => {
  beforeEach(() => __resetSkips());

  test("prix-carburants keeps each grade's own update time", () => {
    const { observations } = parse();
    const prices = readings(observations, 89100001, "fuel.price");
    // The export labels the publisher's Paris wall-clock times +00:00.
    expect(prices.get("diesel")!["phenomenonTime"]).toEqual({ instant: "2026-10-14T05:40:05Z" });
    expect(prices.get("sp98")!["phenomenonTime"]).toEqual({ instant: "2026-10-14T05:37:51Z" });
    // A price twelve days old is still that price, at its own time.
    expect(prices.get("e85")!["phenomenonTime"]).toEqual({ instant: "2026-10-05T10:16:34Z" });
    expect(prices.get("diesel")!["result"]).toEqual({
      type: "money",
      amount: "2.399",
      currency: "EUR",
      per: "L",
    });
    for (const o of prices.values()) {
      expect(o["id"]).toBe(observationId("fr-prixcarburants-fuel", o as never));
    }
  });

  test("a temporary rupture is a product that is not available, with no price", () => {
    const { features, observations } = parse();
    expect(keys(station(features, 82800001))).toContain("lpg");
    expect(readings(observations, 82800001, "fuel.price").has("lpg")).toBe(false);
    const available = readings(observations, 82800001, "fuel.product_available");
    expect(available.get("lpg")!["result"]).toEqual({ type: "boolean", value: false });
    expect(available.get("diesel")!["result"]).toEqual({ type: "boolean", value: true });
    expect(available.get("lpg")!["phenomenonTime"]).toEqual({ instant: FETCHED });
  });

  test("a definitive rupture is a grade the station does not sell", () => {
    const { features, observations } = parse();
    expect(keys(station(features, 89100001))).toEqual(["diesel", "e10", "sp98", "e85"]);
    expect(readings(observations, 89100001, "fuel.product_available").has("e5")).toBe(false);
    expect(readings(observations, 89100001, "fuel.price").has("e5")).toBe(false);
  });

  test("a grade listed unavailable without a rupture is not sold", () => {
    const { features, observations } = parse();
    // 82800001 lists E85 unavailable and reports no rupture of it.
    expect(keys(station(features, 82800001))).not.toContain("e85");
    expect(readings(observations, 82800001, "fuel.product_available").has("e85")).toBe(false);
  });

  test("a rupture of a type the parser does not know is a stock-out counted as a value not read", () => {
    const { observations } = parse(patched(38230003, { e10_rupture_type: "partielle" }));
    const available = readings(observations, 38230003, "fuel.product_available");
    expect(available.get("e10")!["result"]).toEqual({ type: "boolean", value: false });
    expect(readings(observations, 38230003, "fuel.price").has("e10")).toBe(false);
    expect(drainSkipped(FEED)).toEqual({ unknown_value: 1 });
  });

  test("maps the six grades the ministry prices", () => {
    const { features } = parse();
    const tignieu = station(features, 38230003);
    expect(keys(tignieu)).toEqual(["diesel", "e5", "e10", "sp98", "e85", "lpg"]);
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

  test("a motorway service area: the road class, its services and natural gas", () => {
    const { features, observations } = parse();
    const mornas = station(features, 84550004);
    expect((mornas["location"] as Draft)["roads"]).toEqual([{ class: "motorway" }]);
    expect(mornas["amenities"]).toEqual([
      "toilets",
      "shower",
      "food_shopping",
      "shop",
      "takeaway",
      "restaurant",
      "compressed_air",
      "baby_changing",
      "charging_station",
      "fuel_additives",
      "wifi",
      "cash_machine",
    ]);
    expect(mornas["access"]).toEqual({
      audience: "public",
      payment: ["credit_card", "debit_card"],
    });
    expect(mornas["details"]).toEqual({
      kind: "fuel_station",
      v: 1,
      productsComplete: true,
      truckSuitable: true,
    });
    // The flux prices no natural gas: the service list makes it a product without readings.
    expect(keys(mornas)).toEqual(["diesel", "e10", "sp98", "e85", "lpg", "cng"]);
    expect(readings(observations, 84550004, "fuel.price").has("cng")).toBe(false);
    expect(readings(observations, 84550004, "fuel.product_available").has("cng")).toBe(false);
    // A station on another road names none.
    expect((station(features, 89100001)["location"] as Draft)["roads"]).toBeUndefined();
  });

  test("a station without services has no amenities and no payment", () => {
    const { features } = parse(patched(84550004, { services_service: null }));
    const mornas = station(features, 84550004);
    expect(mornas["amenities"]).toBeUndefined();
    expect(mornas["access"]).toEqual({ audience: "public" });
    expect((mornas["details"] as Draft)["truckSuitable"]).toBeUndefined();
    expect(keys(mornas)).not.toContain("cng");
  });

  test("a service or road position the parser does not know is a value not read", () => {
    const out = parse(patched(38230003, { services_service: ["Automate CB 24/24", "Karting"] }));
    expect(station(out.features, 38230003)["access"]).toMatchObject({
      payment: ["credit_card", "debit_card"],
    });
    expect(drainSkipped(FEED)).toEqual({ unknown_value: 1 });
    const road = parse(patched(38230003, { pop: "X" }));
    expect((station(road.features, 38230003)["location"] as Draft)["roads"]).toBeUndefined();
    expect(drainSkipped(FEED)).toEqual({ unknown_value: 1 });
  });

  test("a card terminal open round the clock opens the station 24/7", () => {
    const { features } = parse();
    expect(station(features, 38230003)["openingHours"]).toEqual({
      osm: "24/7",
      twentyFourSeven: true,
    });
    // Its counter days, all marked closed with 01.00-01.00, do not matter.
    expect(station(features, 84550004)["openingHours"]).toEqual({
      osm: "24/7",
      twentyFourSeven: true,
    });
  });

  test("counter hours: closed days are off, split days keep both intervals", () => {
    const { features } = parse();
    expect(station(features, 57580002)["openingHours"]).toEqual({
      osm: "Mo-Th 08:30-12:00,14:00-19:00; Fr-Sa 08:30-19:00; Su off",
    });
    // No hours at all.
    expect(station(features, 89100001)["openingHours"]).toBeUndefined();
  });

  test.each([
    {
      what: "a closing time of midnight is the end of the day",
      jour: [1, 2, 3, 4, 5, 6, 7].map((id) =>
        day(id, { horaire: { "@ouverture": "06.00", "@fermeture": "00.00" } }),
      ),
      osm: "Mo-Su 06:00-24:00",
      skipped: {},
    },
    {
      what: "a day neither closed nor given hours leaves the week without hours",
      jour: [1, 2, 3, 4, 5, 6, 7].map((id) =>
        day(id, id === 3 ? {} : { horaire: { "@ouverture": "07.00", "@fermeture": "19.00" } }),
      ),
      osm: undefined,
      skipped: {},
    },
    {
      what: "an interval opening and closing at the same time is not read",
      jour: [1, 2, 3, 4, 5, 6, 7].map((id) =>
        day(id, { horaire: { "@ouverture": "00.00", "@fermeture": "00.00" } }),
      ),
      osm: undefined,
      skipped: { unknown_value: 1 },
    },
    {
      what: "a time that is not a time of day is not read",
      jour: [1, 2, 3, 4, 5, 6, 7].map((id) =>
        day(id, { horaire: { "@ouverture": "07h00", "@fermeture": "19.00" } }),
      ),
      osm: undefined,
      skipped: { unknown_value: 1 },
    },
  ])("$what", ({ jour, osm, skipped }) => {
    const { features } = parse(patched(57580002, { horaires: horaires(jour) }));
    expect(station(features, 57580002)["openingHours"]).toEqual(
      osm === undefined ? undefined : { osm },
    );
    expect(drainSkipped(FEED)).toEqual(skipped);
  });

  test("horaires that are not JSON are a value not read", () => {
    const { features } = parse(patched(57580002, { horaires: "Lundi 08.00-12.00" }));
    expect(station(features, 57580002)["openingHours"]).toBeUndefined();
    expect(drainSkipped(FEED)).toEqual({ unknown_value: 1 });
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

  test("a station at 0,0 is skipped as unplaced; one off the globe as malformed", () => {
    const out = parse(patched(38230003, { geom: { lon: 0, lat: 0 } }));
    expect(out.features.map((f) => f["id"])).not.toContain(featureId(38230003));
    expect(out.rejected ?? 0).toBe(0);
    expect(drainSkipped(FEED)).toEqual({ no_geometry: 1 });
    const outside = parse(patched(38230003, { geom: { lon: 5.183, lat: 145.745 } }));
    expect(outside.features).toHaveLength(4);
    expect(drainSkipped(FEED)).toEqual({ malformed: 1 });
    parse(patched(38230003, { geom: null }));
    expect(drainSkipped(FEED)).toEqual({ no_geometry: 1 });
  });

  test("a station without an id is skipped as malformed", () => {
    const out = parse(patched(38230003, { id: null }));
    expect(out.features).toHaveLength(4);
    expect(drainSkipped(FEED)).toEqual({ malformed: 1 });
  });

  test("a grade the availability lists name but the parser does not know is a value not read", () => {
    const out = parse(patched(38230003, { carburants_disponibles: ["Gazole", "SP95", "B100"] }));
    expect(out.features).toHaveLength(5);
    expect(drainSkipped(FEED)).toEqual({ unknown_value: 1 });
  });

  test("the live fixture reads without a value left unread", () => {
    parse();
    expect(drainSkipped(FEED)).toEqual({});
  });

  test("every drafted record seals", () => {
    const { features, observations } = parse();
    expect(features).toHaveLength(5);
    expect(sealFailures([...features, ...observations])).toEqual([]);
  });
});
