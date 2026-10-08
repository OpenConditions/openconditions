import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  connectorPowerKw,
  decodeOcpiList,
  normaliseEmi3,
  normaliseLocation,
  normaliseTariff,
  type OcpiLocation,
  type OcpiTariff,
} from "../index.js";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

const json = (name: string): unknown => JSON.parse(fixture(name).toString("utf8"));

describe("decodeOcpiList", () => {
  test("an OCPI envelope, a bare array and an OCPDB page decode to the same locations", () => {
    const ndw = json("ndw-locations.json") as unknown[];
    const bare = decodeOcpiList<unknown>(Buffer.from(JSON.stringify(ndw)));
    const envelope = decodeOcpiList<unknown>(
      Buffer.from(
        JSON.stringify({ data: ndw, status_code: 1000, status_message: "Success", timestamp: "x" }),
      ),
    );
    const page = decodeOcpiList<unknown>(
      Buffer.from(JSON.stringify({ items: ndw, total_count: 4, next_offset: null })),
    );
    expect(bare).toHaveLength(4);
    expect(envelope).toEqual(bare);
    expect(page).toEqual(bare);
    expect(bare.map((l) => normaliseLocation(l).id)).toEqual(
      envelope.map((l) => normaliseLocation(l).id),
    );
  });

  test("the Lithuanian envelope on the wire decodes to its data", () => {
    const list = decodeOcpiList<{ id: number }>(fixture("lt-locations.json"));
    expect(list.map((l) => l.id)).toEqual([258, 440, 278]);
  });

  test("an OCPI failure status, a non-list body and invalid JSON are rejected", () => {
    expect(() =>
      decodeOcpiList(Buffer.from(JSON.stringify({ status_code: 2001, data: [] }))),
    ).toThrow(/2001/);
    expect(() => decodeOcpiList(Buffer.from(JSON.stringify({ data: { id: 1 } })))).toThrow(/list/);
    expect(() => decodeOcpiList(Buffer.from("<html>"))).toThrow();
  });
});

describe("normaliseLocation", () => {
  test("string coordinates become numbers and numeric ids become strings", () => {
    const location = normaliseLocation({
      country_code: "LT",
      party_id: "IGN",
      id: 440,
      publish: true,
      coordinates: { latitude: "56.0562790", longitude: "24.4085320" },
      evses: [
        {
          uid: 69058,
          status: "AVAILABLE",
          connectors: [{ id: 706999, standard: "IEC_62196_T2", tariff_ids: [4, "x"] }],
        },
      ],
    });
    expect(location.coordinates).toEqual({ latitude: 56.056279, longitude: 24.408532 });
    expect(location.id).toBe("440");
    expect(location.evses[0]).toMatchObject({ uid: "69058", status: "AVAILABLE" });
    expect(location.evses[0]?.connectors[0]).toMatchObject({
      id: "706999",
      tariff_ids: ["4", "x"],
    });
  });

  test("a location without usable coordinates is rejected", () => {
    expect(() =>
      normaliseLocation({ id: "1", coordinates: { latitude: "x", longitude: 1 } }),
    ).toThrow(/coordinates/);
    expect(() => normaliseLocation({ coordinates: { latitude: 1, longitude: 1 } })).toThrow(/id/);
  });

  test("a connector id shared by two EVSEs stays on each EVSE", () => {
    const location = normaliseLocation({
      id: "L",
      coordinates: { latitude: 1, longitude: 2 },
      evses: [
        { uid: "a", status: "AVAILABLE", connectors: [{ id: "1", standard: "IEC_62196_T2" }] },
        { uid: "b", status: "CHARGING", connectors: [{ id: "1", standard: "IEC_62196_T2" }] },
      ],
    });
    expect(location.evses.map((e) => [e.uid, e.status, e.connectors[0]?.id])).toEqual([
      ["a", "AVAILABLE", "1"],
      ["b", "CHARGING", "1"],
    ]);
  });

  test("NDW: a publish:false location is kept with publish false", () => {
    const [hidden, ...rest] = (json("ndw-locations.json") as unknown[]).map((l) =>
      normaliseLocation(l),
    );
    expect(hidden).toMatchObject({ id: "TEU_04554", party_id: "EVT", publish: false });
    expect(hidden?.evses[0]?.status).toBe("CHARGING");
    expect(rest.every((l) => l.publish === true)).toBe(true);
  });

  test("NDW: nulls are absent and a connector without power keeps its voltage and amperage", () => {
    const locations = (json("ndw-locations.json") as unknown[]).map((l) => normaliseLocation(l));
    const dc = locations.find((l) => l.id === "12084")?.evses[0]?.connectors[0];
    expect(dc).toBeDefined();
    expect("max_electric_power" in (dc as object)).toBe(false);
    expect(dc).toMatchObject({ power_type: "DC", max_voltage: 500, max_amperage: 120 });
    expect(connectorPowerKw(dc as never)).toBe(60);
  });

  test("Lithuania 2.3.0: naive local times and voltage/amperage names are read as sent", () => {
    const [vilnius, pasvalys] = decodeOcpiList<unknown>(fixture("lt-locations.json")).map((l) =>
      normaliseLocation(l),
    );
    expect(vilnius?.last_updated).toBe("2026-10-06T00:01:09");
    expect(vilnius?.time_zone).toBe("Europe/Vilnius");
    expect(vilnius?.country).toBe("LTU");
    expect(vilnius?.evses.map((e) => e.uid)).toEqual(["535", "12032"]);
    expect(vilnius?.evses[0]?.last_updated).toBe("2026-10-06T00:01:09");
    expect(pasvalys?.evses[0]?.connectors[0]).toMatchObject({
      id: "706999",
      max_voltage: 400,
      max_amperage: 18,
      max_electric_power: 22000,
      power_type: "AC_1_PHASE",
      tariff_ids: ["4"],
    });
  });

  test("publish and tax_included of 2.3.0 are read", () => {
    const location = normaliseLocation({
      id: "1",
      publish: false,
      coordinates: { latitude: 1, longitude: 2 },
    });
    expect(location.publish).toBe(false);
    expect(
      normaliseTariff({ id: "t", currency: "EUR", tax_included: "yes", elements: [] }).tax_included,
    ).toBe("YES");
  });

  test("opening times keep the weekday as a number and the hours as written", () => {
    const location = normaliseLocation({
      id: "1",
      coordinates: { latitude: 1, longitude: 2 },
      opening_times: {
        twentyfourseven: false,
        regular_hours: [{ weekday: 1, period_begin: "08:00", period_end: "18:00" }],
        exceptional_closings: [
          { period_begin: "2026-12-24T00:00:00Z", period_end: "2026-12-26T00:00:00Z" },
        ],
      },
    });
    expect(location.opening_times).toEqual({
      twentyfourseven: false,
      regular_hours: [{ weekday: 1, period_begin: "08:00", period_end: "18:00" }],
      exceptional_closings: [
        { period_begin: "2026-12-24T00:00:00Z", period_end: "2026-12-26T00:00:00Z" },
      ],
    });
  });
});

describe("connector power", () => {
  const power = (c: Record<string, unknown>): number | undefined =>
    connectorPowerKw(
      normaliseLocation({
        id: "1",
        coordinates: { latitude: 1, longitude: 2 },
        evses: [{ uid: "e", connectors: [{ id: "1", standard: "X", ...c }] }],
      }).evses[0]?.connectors[0] as never,
    );

  test("watts become kilowatts", () => {
    expect(power({ max_electric_power: 22000 })).toBe(22);
  });

  test("units in strings are honoured", () => {
    expect(power({ max_electric_power: "11000 W" })).toBe(11);
    expect(power({ max_electric_power: "22 kW" })).toBe(22);
    expect(power({ max_electric_power: "22000" })).toBe(22);
  });

  test("a missing power is voltage times amperage times phases", () => {
    expect(power({ power_type: "AC_3_PHASE", max_voltage: 230, max_amperage: 32 })).toBe(22.08);
    expect(power({ power_type: "AC_1_PHASE", max_voltage: 230, max_amperage: 16 })).toBe(3.68);
    expect(power({ power_type: "DC", max_voltage: 500, max_amperage: 120 })).toBe(60);
  });

  test("power is absent when it cannot be known", () => {
    expect(power({ power_type: "DC", max_voltage: 500 })).toBeUndefined();
    expect(power({ max_electric_power: "n/a" })).toBeUndefined();
    expect(power({ max_electric_power: 0 })).toBeUndefined();
  });
});

describe("normaliseTariff", () => {
  const tariffs = (name: string): OcpiTariff[] =>
    (json(name) as unknown[]).map((t) => normaliseTariff(t));

  test("NDW: a dated and a day-of-week restriction keep both", () => {
    const all = tariffs("ndw-tariffs.json");
    const dated = all.find((t) => t.id === "A0");
    expect(dated?.elements[0]?.restrictions).toEqual({ start_date: "2025-11-19" });
    const weekly = all.find((t) => t.party_id === "TNM");
    expect(weekly?.elements[0]?.restrictions).toMatchObject({
      start_time: "00:00",
      end_time: "23:59",
      day_of_week: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"],
    });
    expect(weekly?.tariff_alt_text).toEqual([{ language: "en", text: "0.392EURperKWH" }]);
  });

  test("NDW: a tariff id shared by two parties stays distinguishable", () => {
    const shared = tariffs("ndw-tariffs.json").filter((t) => t.id === "238");
    expect(shared.map((t) => `${t.country_code}/${t.party_id}`)).toEqual(["NL/CKE", "NL/QWC"]);
  });

  test("VAT is the inline number, unknown VAT is absent and zero stays zero", () => {
    const tariff = normaliseTariff({
      id: "t",
      currency: "EUR",
      elements: [
        {
          price_components: [
            { type: "ENERGY", price: 0.47, vat: 21, step_size: 1 },
            { type: "TIME", price: 0.1, vat: null, step_size: 60 },
            { type: "FLAT", price: 0, vat: 0, step_size: 1 },
          ],
        },
      ],
    });
    expect(tariff.elements[0]?.price_components).toEqual([
      { type: "ENERGY", price: 0.47, vat: 21, step_size: 1 },
      { type: "TIME", price: 0.1, step_size: 60 },
      { type: "FLAT", price: 0, vat: 0, step_size: 1 },
    ]);
  });

  test("Lithuania 2.3.0: string prices, second-resolution times and tax_included are read", () => {
    const all = (json("lt-tariffs.json") as { data: unknown[] }).data.map((t) =>
      normaliseTariff(t),
    );
    const cheap = all.find((t) => t.id === "24");
    expect(cheap).toMatchObject({
      tax_included: "NO",
      min_price: { excl_vat: 0.1 },
      last_updated: "2026-09-11 12:26:21",
    });
    expect(cheap?.elements[0]?.price_components[0]).toEqual({
      type: "ENERGY",
      price: 0.21,
      vat: 21,
      step_size: 1,
    });
    const parking = all.find((t) => t.id === "26");
    expect(parking?.elements[1]?.restrictions).toEqual({ max_duration: 420 });
    expect(all.find((t) => t.id === "t_7c68523e2a9b42c4883e0275ab4fa805")?.tariff_alt_text).toEqual(
      [
        { language: "en", text: "0.38 Eur/kWh" },
        { language: "ru", text: "0.38 Eur/kWh" },
        { language: "lt", text: "0.38 Eur/kWh" },
      ],
    );
    expect(all.find((t) => t.id === "4")?.tax_included).toBeUndefined();
  });

  test("times with seconds are trimmed to the minute", () => {
    const tariff = normaliseTariff({
      id: "t",
      currency: "EUR",
      elements: [
        {
          price_components: [{ type: "ENERGY", price: "0.5", step_size: 1 }],
          restrictions: { start_time: "07:00:00", end_time: "19:30:00" },
        },
      ],
    });
    expect(tariff.elements[0]?.restrictions).toEqual({ start_time: "07:00", end_time: "19:30" });
  });

  test("zero upper bounds mean unset", () => {
    const tariff = normaliseTariff({
      id: "t",
      currency: "EUR",
      elements: [
        {
          price_components: [{ type: "TIME", price: 1, step_size: 1 }],
          restrictions: { min_duration: 1800, max_duration: 0, max_kwh: 0, min_kwh: 5 },
        },
      ],
    });
    expect(tariff.elements[0]?.restrictions).toEqual({ min_duration: 1800, min_kwh: 5 });
  });

  test("a price object keeps both its amounts", () => {
    const tariff = normaliseTariff({
      id: "t",
      currency: "EUR",
      min_price: { excl_vat: 1, incl_vat: 1.19 },
      max_price: { excl_vat: "10.00" },
      elements: [],
    });
    expect(tariff.min_price).toEqual({ excl_vat: 1, incl_vat: 1.19 });
    expect(tariff.max_price).toEqual({ excl_vat: 10 });
  });

  test("a tariff without an id or currency is rejected", () => {
    expect(() => normaliseTariff({ currency: "EUR", elements: [] })).toThrow(/id/);
    expect(() => normaliseTariff({ id: "t", elements: [] })).toThrow(/currency/);
  });
});

describe("normaliseEmi3", () => {
  test("DE*MUC*E*CO1 and DEMUCECO1 are equal", () => {
    expect(normaliseEmi3("DE*MUC*E*CO1")).toBe("DEMUCECO1");
    expect(normaliseEmi3("DEMUCECO1")).toBe("DEMUCECO1");
    expect(normaliseEmi3(" de*muc *e*co1 ")).toBe("DEMUCECO1");
  });
});

describe("wire types", () => {
  test("a normalised location satisfies OcpiLocation", () => {
    const [first] = decodeOcpiList<unknown>(fixture("ndw-locations.json"));
    const location: OcpiLocation = normaliseLocation(first);
    expect(location.evses.length).toBeGreaterThan(0);
  });
});
