import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-06T02:45:56Z";

function parse(payloads: FeedPayloads): ParseOutput {
  const out = chargingDomain.formats["afdc"]!.parse(
    catalogFeed("us-afdc-charging"),
    payloads,
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  details: Record<string, unknown>;
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const site = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:us-afdc-charging:${id}`);
const evsesOf = (draft: RecordDraft | undefined) =>
  components(draft).filter((c) => c.kind === "evse");
const connectorsOf = (draft: RecordDraft | undefined) =>
  components(draft).filter((c) => c.kind === "connector");

const station = (extra: Record<string, unknown>) =>
  Buffer.from(
    JSON.stringify({
      fuel_stations: [
        {
          id: 900,
          fuel_type_code: "ELEC",
          status_code: "E",
          station_name: "Test",
          latitude: 40,
          longitude: -100,
          country: "US",
          ...extra,
        },
      ],
    }),
  );

const unit = (
  connectors: Record<string, { power_kw: number | null; port_count: number }>,
  portCount: number,
  level = "2",
) => ({ network: "N", connectors, port_count: portCount, charging_level: level });

describe("afdc", () => {
  beforeEach(() => __resetSkips());

  test("AFDC: charging units give per-connector power and quantity; NEMA is never Schuko", () => {
    const out = parse({ main: [fixture("afdc-more.json")] });
    // Every code the captures write is one AFDC lists.
    parse({ main: [fixture("afdc.json")] });
    expect(drainSkipped("us-afdc-charging")).toEqual({});
    // A Tesla Supercharger: eight units of one 150 kW port.
    const tesla = site(out, "83915");
    expect(evsesOf(tesla)).toHaveLength(8);
    expect(connectorsOf(tesla)[0]?.details).toMatchObject({
      standard: "SAE_J3400",
      current: "dc",
      maxPowerKw: 150,
    });
    expect(tesla).toMatchObject({
      location: { address: { country: "CA", city: "Comber", postalCode: expect.any(String) } },
      operator: { name: [{ lang: "en", text: "Tesla" }] },
    });
    // A campground: a Level 1 NEMA 14-50 outlet and a J1772 plug.
    const camp = site(out, "48640");
    expect(connectorsOf(camp).map((c) => c.details)).toEqual([
      { kind: "connector", v: 1, standard: "NEMA_14_50", format: "socket", current: "ac" },
      { kind: "connector", v: 1, standard: "IEC_62196_T1", format: "cable", current: "ac" },
    ]);
    expect(camp?.["operator"]).toBeUndefined();
    expect(camp?.["details"]).toMatchObject({ tariffText: [{ lang: "en", text: "$15 per day" }] });
    // One port that carries a CHAdeMO and a CCS cable is one EVSE of two connectors, and
    // a connector count above the port count is not a count of charge points.
    const mixed = site(out, "121703");
    const lastEvse = evsesOf(mixed).at(-1)!;
    expect(
      components(mixed)
        .filter((c) => c.parentKey === lastEvse.key)
        .map((c) => [c.details["standard"], c.details["maxPowerKw"]]),
    ).toEqual([
      ["CHADEMO", 50],
      ["IEC_62196_T1_COMBO", 150],
    ]);
    expect(evsesOf(mixed).every((e) => e.details["quantity"] === undefined)).toBe(true);
  });

  test("AFDC: a unit of N identical ports of one connector is one EVSE of that quantity", () => {
    const out = parse({
      main: [
        station({
          ev_charging_units: [
            unit(
              { J1772: { power_kw: 7.2, port_count: 3 }, TESLA: { power_kw: null, port_count: 0 } },
              3,
            ),
            unit({ NEMA520: { power_kw: null, port_count: 1 } }, 1, "1"),
          ],
        }),
      ],
    });
    const evses = evsesOf(site(out, "900"));
    expect(evses.map((e) => e.details["quantity"])).toEqual([3, undefined]);
    expect(connectorsOf(site(out, "900")).map((c) => c.details)).toEqual([
      {
        kind: "connector",
        v: 1,
        standard: "IEC_62196_T1",
        format: "cable",
        current: "ac",
        maxPowerKw: 7.2,
      },
      { kind: "connector", v: 1, standard: "NEMA_5_20", format: "socket", current: "ac" },
    ]);
  });

  test("AFDC: without charging units the connector types stand, one EVSE each, with no counts", () => {
    const out = parse({
      main: [
        station({
          ev_connector_types: [
            "J1772",
            "J1772COMBO",
            "CHADEMO",
            "NEMA515",
            "TESLA",
            "J3271",
            "XYZ",
          ],
          ev_level2_evse_num: 4,
          ev_dc_fast_num: 6,
        }),
      ],
    });
    const stationDraft = site(out, "900");
    expect(connectorsOf(stationDraft).map((c) => c.details["standard"])).toEqual([
      "CHADEMO",
      "IEC_62196_T1",
      "IEC_62196_T1_COMBO",
      // "MCS (J3271 DC)".
      "MCS",
      "DOMESTIC_B",
      "SAE_J3400",
      "UNKNOWN",
    ]);
    expect(evsesOf(stationDraft).every((e) => e.details["quantity"] === undefined)).toBe(true);
    // A code AFDC does not list is a connector of unknown standard, its code counted as unread.
    expect(drainSkipped("us-afdc-charging")).toEqual({ unknown_value: 1 });
    // One connector type is all of its ports: the counts say how many.
    const single = parse({
      main: [station({ ev_connector_types: ["J1772"], ev_level2_evse_num: 4 })],
    });
    expect(evsesOf(site(single, "900")).map((e) => e.details["quantity"])).toEqual([4]);
    // Two levels may share one type: the total is not that type's count.
    const shared = parse({
      main: [station({ ev_connector_types: ["J1772"], ev_level2_evse_num: 4, ev_dc_fast_num: 2 })],
    });
    expect(evsesOf(site(shared, "900")).map((e) => e.details["quantity"])).toEqual([undefined]);
    // A null coordinate is no position.
    const unplaced = parse({ main: [station({ latitude: null })] });
    expect(unplaced.features).toEqual([]);
    expect(drainSkipped("us-afdc-charging")).toEqual({ no_geometry: 1 });
  });

  test("AFDC: P is planned and T temporarily closed; E is a register state, never a reading", () => {
    const out = parse({ main: [fixture("afdc-more.json"), fixture("afdc.json")] });
    expect(site(out, "63615")).toMatchObject({ lifecycle: "planned" });
    expect(site(out, "1523")).toMatchObject({
      lifecycle: "operational",
      name: [{ lang: "en", text: "Los Angeles Convention Center" }],
      location: {
        geometry: { type: "Point", coordinates: [-118.271387, 34.040539] },
        address: {
          street: "1201 S Figueroa St",
          city: "Los Angeles",
          postalCode: "90015",
          country: "US",
        },
      },
    });
    expect(site(out, "1523")?.["openingHours"]).toBeUndefined();
    expect(site(out, "1523")?.["details"]).toMatchObject({
      parkingType: "parking_garage",
      tariffText: [{ lang: "en", text: "Free" }],
      openingHoursText: [{ lang: "en", text: "5:30am-9pm; pay lot" }],
    });
    expect(evsesOf(site(out, "1523"))).toHaveLength(8);
    expect(site(out, "6355")).toMatchObject({ openingHours: { osm: "24/7" } });
    const closed = parse({ main: [station({ status_code: "T" })] });
    expect(site(closed, "900")).toMatchObject({ lifecycle: "temporarily_closed" });
    expect(out.observations).toEqual([]);
  });

  test("AFDC: network names, access, cards, venue, contact and directions as the model holds them", () => {
    const networks = Buffer.from(
      JSON.stringify([
        { key: "all", name: "All" },
        { key: "WATT_EV", name: "WattEV", url: "https://www.wattev.com" },
      ]),
    );
    const out = parse({
      main: [
        station({
          ev_network: "WATT_EV",
          ev_network_ids: { station: ["BKF-1"], posts: ["P1"] },
          access_code: "public",
          access_detail_code: "CREDIT_CARD_ALWAYS",
          cards_accepted: "A M V Debit APPLE_PAY Voyager",
          facility_type: "HOTEL",
          state: "CA",
          zip: "93308",
          plus4: "1234",
          station_phone: "949-916-2751",
          intersection_directions: "Behind the lobby",
          intersection_directions_fr: "Derrière le hall",
          federal_agency: { id: 3, code: "DOE", name: "Department of Energy" },
          ev_workplace_charging: true,
          ev_connector_types: ["J1772"],
        }),
      ],
      networks: [networks],
    });
    expect(drainSkipped("us-afdc-charging")).toEqual({});
    expect(site(out, "900")).toMatchObject({
      operator: { name: [{ text: "WattEV" }], website: "https://www.wattev.com" },
      owner: { name: [{ text: "Department of Energy" }] },
      externalIds: expect.arrayContaining([{ scheme: "cpo", id: "BKF-1", authority: "WATT_EV" }]),
      location: { address: { region: "CA", postalCode: "93308-1234" } },
      access: {
        audience: "public",
        payment: ["credit_card", "debit_card", "contactless", "other"],
      },
      amenities: ["hotel"],
      details: {
        hotline: "949-916-2751",
        directions: [
          { lang: "en", text: "Behind the lobby" },
          { lang: "fr", text: "Derrière le hall" },
        ],
      },
    });
    expect(evsesOf(site(out, "900"))[0]?.details).toMatchObject({
      parkingRestrictions: ["employees"],
    });
    // Reserved for a business's patrons, or fleet only.
    expect(site(parse({ main: [station({ restricted_access: true })] }), "900")).toMatchObject({
      access: { audience: "customers" },
    });
    expect(site(parse({ main: [station({ access_detail_code: "FLEET" })] }), "900")).toMatchObject({
      access: { audience: "restricted" },
    });
    // A paid garage is a garage; codes AFDC does not list are counted.
    expect(
      site(parse({ main: [station({ facility_type: "PAY_GARAGE" })] }), "900")?.["details"],
    ).toMatchObject({ parkingType: "parking_garage" });
    parse({
      main: [
        station({
          facility_type: "SPACEPORT",
          cards_accepted: "BITCOIN",
          access_detail_code: "toString",
          ev_charging_units: [unit({ J1772: { power_kw: 7, port_count: 1 } }, 1, "3")],
        }),
      ],
    });
    expect(drainSkipped("us-afdc-charging")).toEqual({ unknown_value: 4 });
  });

  test("AFDC: a station of another fuel is no site and is counted as a record of an unknown type", () => {
    expect(parse({ main: [station({ fuel_type_code: "CNG" })] }).features).toEqual([]);
    expect(drainSkipped("us-afdc-charging")).toEqual({ unknown_type: 1 });
  });
});
