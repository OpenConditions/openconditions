import { __resetSkips, drainSkipped, type ParseOutput } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { parseDbBahnpark } from "../formats/db-bahnpark.js";
import { dbBahnparkFeed, fixture, parseContext } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-05T04:00:00Z";

function parse(body: Buffer): ParseOutput {
  const out = parseDbBahnpark(dbBahnparkFeed(), { main: [body] }, parseContext(FETCHED, 86400));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const sample = () => parse(fixture("db-bahnpark-sample.json"));

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => f["id"] === `oc:feature:de-db-bahnpark-parking:${stationId}`);

const areas = (out: ParseOutput, stationId: string) =>
  (
    (site(out, stationId)?.["components"] ?? []) as {
      key: string;
      details: { capacity?: number };
    }[]
  ).map((c) => [c.key, c.details.capacity]);

/** One facility with the given prices, as the API writes it. */
const facility = (prices: { duration: string; price: number; group?: string }[]) => ({
  id: "500",
  name: [{ name: "Test P1", context: "NAME" }],
  type: { name: "Parkplatz" },
  address: { location: { latitude: 50.1, longitude: 8.6 } },
  tariff: {
    prices: prices.map((p) => ({
      group: { groupName: p.group ?? "standard" },
      duration: p.duration,
      price: p.price,
    })),
  },
});

type Element = {
  components: { price: { amount: string } }[];
  restrictions?: { maxDuration?: unknown; userGroups?: string[] };
};

const rows = (out: ParseOutput) =>
  ((out.offers[0]?.["elements"] ?? []) as Element[]).map((e) => [
    e.components[0]?.price.amount,
    e.restrictions?.maxDuration,
    e.restrictions?.userGroups,
  ]);

describe("db-bahnpark", () => {
  test("DB BahnPark: P-Card prices are rates for P-Card holders, not a public price", () => {
    const out = parse(
      Buffer.from(
        JSON.stringify([
          facility([
            { duration: "20min", price: 1 },
            { duration: "1hour", price: 2.5 },
            { duration: "1day", price: 12 },
            { duration: "1dayPCard", price: 9 },
            { duration: "1weekPCard", price: 40 },
            { duration: "1monthVendingMachine", price: 80 },
            { duration: "1monthLongTerm", price: 70 },
            { duration: "1monthReservation", price: 90 },
            { duration: "1hour", price: 1.5, group: "monthly" },
          ]),
        ]),
      ),
    );
    expect(out.offers).toHaveLength(1);
    expect(out.offers[0]).toMatchObject({
      id: "oc:offer:de-db-bahnpark-parking:500:1",
      kind: "parking_rate",
      currency: "EUR",
      subject: { class: "feature", id: "oc:feature:de-db-bahnpark-parking:500" },
    });
    expect(rows(out)).toEqual([
      ["1.00", { value: 20, unit: "min" }, undefined],
      ["2.50", { value: 1, unit: "h" }, undefined],
      ["12.00", { value: 1, unit: "d" }, undefined],
      ["9.00", { value: 1, unit: "d" }, ["p_card"]],
      ["40.00", { value: 1, unit: "wk" }, ["p_card"]],
      ["80.00", { value: 1, unit: "mo" }, undefined],
      ["70.00", { value: 1, unit: "mo" }, ["long_term"]],
      ["90.00", { value: 1, unit: "mo" }, ["reservation"]],
    ]);
    expect(rows(sample())).toEqual([
      ["3.00", { value: 1, unit: "h" }, undefined],
      ["18.00", { value: 1, unit: "d" }, undefined],
      ["140.00", { value: 1, unit: "mo" }, ["long_term"]],
    ]);
  });

  test("DB BahnPark: a charging station is an EV area without a count", () => {
    const out = sample();
    expect(areas(out, "100")).toEqual([
      ["car:any", 920],
      ["car:disabled", 16],
      ["car:ev_charging", undefined],
    ]);
    expect(out.observations).toEqual([]);
  });

  test("DB BahnPark: name, type, layout, clearance, payment, hours and service state", () => {
    const out = sample();
    expect(site(out, "100")).toMatchObject({
      type: "off_street",
      lifecycle: "operational",
      name: [{ lang: "de", text: "Berlin Hbf P1 (Display)" }],
      // The operator's page comes without a scheme.
      operator: {
        role: "operator",
        name: [{ lang: "de", text: "Contipark Parkgaragengesellschaft mbH" }],
        website: "https://www.mein-contipark.de",
      },
      // Coins, credit card, bank card, the app and the operator's Pcard.
      access: { payment: ["cash", "credit_card", "debit_card", "app", "membership"] },
      openingHours: { osm: "24/7", twentyFourSeven: true },
      location: {
        geometry: { coordinates: [13.369, 52.525] },
        address: { street: "Europaplatz 1", postalCode: "10557", city: "Berlin", country: "DE" },
      },
      details: {
        layout: "multi_storey",
        capacityTotal: 920,
        heightLimit: { value: 2, unit: "m" },
        widthLimit: { value: 2.3, unit: "m" },
        website: "https://www.bahnpark.de/p100",
      },
    });
    expect(site(out, "200")).toMatchObject({
      type: "park_and_ride",
      name: [{ lang: "de", text: "Hamburg Altona P+R" }],
      details: { usage: ["park_and_ride"], capacityTotal: 400 },
    });
    expect(site(out, "200")?.["details"]).not.toHaveProperty("layout");
    // Out of service, with a published capacity of 0: closed, and no area.
    expect(site(out, "300")).toMatchObject({
      lifecycle: "temporarily_closed",
      details: { layout: "underground" },
    });
    expect(areas(out, "300")).toEqual([]);
    expect(out.offers.map((o) => o["id"])).toEqual(["oc:offer:de-db-bahnpark-parking:100:1"]);
  });

  test("DB BahnPark: opening hours that are not round the clock are kept as text", () => {
    const out = parse(
      Buffer.from(
        JSON.stringify([
          {
            ...facility([]),
            access: { openingHours: { is24h: false, text: "Mo-Fr 06:00-22:00 Uhr" } },
          },
        ]),
      ),
    );
    expect(site(out, "500")).toMatchObject({
      details: { openingHoursText: [{ lang: "de", text: "Mo-Fr 06:00-22:00 Uhr" }] },
    });
    expect(site(out, "500")).not.toHaveProperty("openingHours");
    // An `_embedded` envelope is read as the list.
    const hal = parse(Buffer.from(JSON.stringify({ _embedded: [facility([])] })));
    expect(hal.features).toHaveLength(1);
  });
});

describe("db-bahnpark skips", () => {
  beforeEach(() => __resetSkips());

  const json = (value: unknown) => Buffer.from(JSON.stringify(value));

  test("DB BahnPark: a facility without a point has no geometry; one without an id is malformed", () => {
    const { id: _, ...anonymous } = facility([]);
    const out = parse(
      json([
        { ...facility([]), address: { location: { latitude: null, longitude: null } } },
        anonymous,
        { ...facility([]), address: { location: { latitude: "50.1", longitude: 8.6 } } },
      ]),
    );
    expect(out.features).toEqual([]);
    expect(drainSkipped(dbBahnparkFeed().id)).toEqual({ no_geometry: 1, malformed: 2 });
  });

  test("DB BahnPark: a facility type, price group or duration code it does not know is an unknown value", () => {
    const out = parse(
      json([
        {
          ...facility([
            { duration: "1hour", price: 2 },
            { duration: "1fortnight", price: 20 },
            // A price of another group is no standard price.
            { duration: "1hour", price: 20, group: "corporate" },
          ]),
          type: { name: "Parkdeck" },
        },
      ]),
    );
    expect(out.features).toHaveLength(1);
    expect(rows(out)).toEqual([["2.00", { value: 1, unit: "h" }, undefined]]);
    expect(drainSkipped(dbBahnparkFeed().id)).toEqual({ unknown_value: 3 });
  });

  test("DB BahnPark: a point off the globe is malformed; null names, prices and capacities name nothing", () => {
    const base = facility([{ duration: "1hour", price: 2 }]);
    const out = parse(
      json([
        { ...facility([]), id: "off", address: { location: { latitude: 50.1, longitude: 180.5 } } },
        {
          ...base,
          name: [null, ...base.name],
          tariff: { prices: [null, ...base.tariff.prices] },
          capacity: [null, { type: "PARKING", total: 40 }],
        },
      ]),
    );
    expect(out.features.map((f) => String(f["id"]).split(":").pop())).toEqual(["500"]);
    expect(out.features[0]?.["name"]).toEqual([{ lang: "de", text: "Test P1" }]);
    expect(rows(out)).toEqual([["2.00", { value: 1, unit: "h" }, undefined]]);
    expect(drainSkipped(dbBahnparkFeed().id)).toEqual({ malformed: 1 });
  });

  test("DB BahnPark: the sample skips nothing", () => {
    sample();
    expect(drainSkipped(dbBahnparkFeed().id)).toEqual({});
  });

  test("DB BahnPark: a clearance is centimetres unless it says metres", () => {
    const clearance = (height: unknown) =>
      (
        site(
          parse(
            json([
              {
                ...facility([]),
                access: { restrictions: { clearance: { height } } },
              },
            ]),
          ),
          "500",
        )?.["details"] as { heightLimit?: unknown } | undefined
      )?.heightLimit;
    expect(clearance("204.99999999999997")).toEqual({ value: 2.05, unit: "m" });
    expect(clearance("3 m")).toEqual({ value: 3, unit: "m" });
    expect(clearance("190 cm")).toEqual({ value: 1.9, unit: "m" });
    expect(clearance("unbegrenzt")).toBeUndefined();
    expect(clearance(null)).toBeUndefined();
  });
});
