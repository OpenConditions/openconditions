import type { ParseOutput } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
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
    // The fixture's standard prices; its `monthly` group price is not a standard rate.
    expect(rows(sample())).toEqual([
      ["3.00", { value: 1, unit: "h" }, undefined],
      ["18.00", { value: 1, unit: "d" }, undefined],
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

  test("DB BahnPark: name, type, layout, height, hours and service state", () => {
    const out = sample();
    expect(site(out, "100")).toMatchObject({
      type: "off_street",
      lifecycle: "operational",
      name: [{ lang: "de", text: "Berlin Hbf P1 (Display)" }],
      operator: { role: "operator", name: [{ lang: "de", text: "DB BahnPark" }] },
      openingHours: { osm: "24/7", twentyFourSeven: true },
      location: {
        geometry: { coordinates: [13.369, 52.525] },
        address: { street: "Europaplatz 1", postalCode: "10557", city: "Berlin", country: "DE" },
      },
      details: {
        layout: "multi_storey",
        capacityTotal: 920,
        heightLimit: { value: 2, unit: "m" },
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
