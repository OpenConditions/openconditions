import { normaliseTariff } from "@openconditions/ocpi";
import { describe, expect, test } from "vitest";
import { type ChargingFeed, siteId } from "../site.js";
import { tariffDraft, tariffOfferId, unreadableTariff } from "../tariff.js";
import { sealFailures } from "./helpers/seal.js";

const FEED: ChargingFeed = {
  id: "de-test-charging",
  format: "ocpi",
  attribution: "Test publisher",
  license: "CC-BY-4.0",
  region: "de",
};
const CTX = { fetchedAt: "2026-10-06T06:00:00Z", point: [8.4037, 49.0069] as [number, number] };

const offer = (raw: Record<string, unknown>) => {
  const draft = tariffDraft(FEED, "LOC1", normaliseTariff({ currency: "EUR", ...raw }), CTX);
  if (draft !== undefined) expect(sealFailures([draft])).toEqual([]);
  return draft;
};

describe("tariffDraft", () => {
  test("an OCPI tariff with a night window on weekdays becomes one offer with days and times", () => {
    const draft = offer({
      id: "NIGHT",
      type: "REGULAR",
      elements: [
        {
          price_components: [{ type: "ENERGY", price: 0.39, vat: 19, step_size: 1 }],
          restrictions: {
            start_time: "18:00",
            end_time: "08:00",
            day_of_week: ["MONDAY", "TUESDAY"],
          },
        },
        { price_components: [{ type: "ENERGY", price: 0.59, vat: 19 }] },
      ],
    });
    expect(draft).toMatchObject({
      id: "oc:offer:de-test-charging:LOC1:NIGHT",
      class: "offer",
      kind: "energy_tariff",
      subject: { class: "feature", id: "oc:feature:de-test-charging:LOC1" },
      currency: "EUR",
      tariffType: "regular",
      priceIncludesVat: false,
      validity: { status: "active" },
      elements: [
        {
          components: [
            {
              type: "energy",
              price: { amount: "0.39", currency: "EUR" },
              vatPct: 19,
              stepSize: 1,
              unit: "kW.h",
            },
          ],
          restrictions: { startTime: "18:00", endTime: "08:00", days: ["MO", "TU"] },
        },
        { components: [{ type: "energy", price: { amount: "0.59", currency: "EUR" } }] },
      ],
    });
    expect(draft?.["subject"]).not.toHaveProperty("componentKey");
    expect((draft?.["elements"] as unknown[] | undefined)?.[1]).not.toHaveProperty("restrictions");
  });

  test("min_price keeps excl_vat; a maximum of 0, as NDW and OCPDB write an unset one, sets none", () => {
    const draft = offer({
      id: "T1",
      min_price: { excl_vat: 1.5, incl_vat: 1.79 },
      max_price: { excl_vat: 40, incl_vat: 47.6 },
      elements: [
        {
          price_components: [{ type: "TIME", price: 6, step_size: 60 }],
          restrictions: { min_duration: 7200, max_duration: 0, max_kwh: 0, min_kwh: 0.5 },
        },
      ],
    });
    expect(draft).toMatchObject({
      minPrice: { amount: "1.5", currency: "EUR" },
      maxPrice: { amount: "40", currency: "EUR" },
      priceIncludesVat: false,
      elements: [
        {
          components: [{ type: "time", price: { amount: "6", currency: "EUR" }, unit: "h" }],
          restrictions: { minDuration: { value: 7200, unit: "s" }, minKwh: 0.5 },
        },
      ],
    });
    const elements = draft?.["elements"] as { restrictions: object }[] | undefined;
    const restrictions = elements?.[0]?.restrictions;
    expect(restrictions).not.toHaveProperty("maxDuration");
    expect(restrictions).not.toHaveProperty("maxKwh");
  });

  test("every restriction OCPI defines has its place", () => {
    const draft = offer({
      id: "ALL",
      type: "AD_HOC_PAYMENT",
      tariff_alt_text: [{ language: "de", text: "Ad-hoc-Tarif" }],
      tariff_alt_url: "https://example.org/tarife",
      start_date_time: "2026-01-01T00:00:00Z",
      elements: [
        {
          price_components: [
            { type: "FLAT", price: 1 },
            { type: "PARKING_TIME", price: 2.4, vat: 7 },
          ],
          restrictions: {
            start_date: "2026-01-01",
            end_date: "2026-12-31",
            min_current: 16,
            max_current: 32,
            min_power: 11,
            max_power: 150,
            max_duration: 1800,
            reservation: "RESERVATION_EXPIRES",
          },
        },
      ],
    });
    expect(draft).toMatchObject({
      tariffType: "ad_hoc",
      altText: [{ lang: "de", text: "Ad-hoc-Tarif" }],
      url: "https://example.org/tarife",
      validity: { status: "active", start: "2026-01-01T00:00:00Z" },
      elements: [
        {
          components: [
            { type: "flat", price: { amount: "1", currency: "EUR" } },
            {
              type: "parking_time",
              price: { amount: "2.4", currency: "EUR" },
              vatPct: 7,
              unit: "h",
            },
          ],
          restrictions: {
            startDate: "2026-01-01",
            endDate: "2026-12-31",
            minCurrentA: 16,
            maxCurrentA: 32,
            minPowerKw: 11,
            maxPowerKw: 150,
            maxDuration: { value: 1800, unit: "s" },
            reservation: "reservation_expires",
          },
        },
      ],
    });
  });

  test("prices that include tax take incl_vat for the bounds", () => {
    const draft = offer({
      id: "INCL",
      tax_included: "YES",
      min_price: { excl_vat: 1.5, incl_vat: 1.79 },
      max_price: { excl_vat: 40 },
      elements: [{ price_components: [{ type: "ENERGY", price: 0.49 }] }],
    });
    expect(draft).toMatchObject({ priceIncludesVat: true, minPrice: { amount: "1.79" } });
    expect(draft).not.toHaveProperty("maxPrice");
  });

  test("2.3.0 PriceLimit bounds take before_taxes, or after_taxes when prices include tax", () => {
    // 2.3.0's min_price and max_price are a PriceLimit: `before_taxes`
    // "excluding taxes", `after_taxes` "including taxes". They were dropped
    // when only 2.2.1's excl_vat and incl_vat were read.
    const elements = [{ price_components: [{ type: "ENERGY", price: 0.49, step_size: 1 }] }];
    const limits = {
      min_price: { before_taxes: 1, after_taxes: 1.21 },
      max_price: { before_taxes: 50, after_taxes: 60.5 },
    };
    expect(offer({ id: "EXCL", tax_included: "NO", ...limits, elements })).toMatchObject({
      priceIncludesVat: false,
      minPrice: { amount: "1", currency: "EUR" },
      maxPrice: { amount: "50", currency: "EUR" },
    });
    expect(offer({ id: "INCL", tax_included: "YES", ...limits, elements })).toMatchObject({
      priceIncludesVat: true,
      minPrice: { amount: "1.21" },
      maxPrice: { amount: "60.5" },
    });
  });

  test("a tax_included OCPI does not define states no VAT status", () => {
    const draft = offer({
      id: "ODD",
      tax_included: "SOMETIMES",
      elements: [{ price_components: [{ type: "ENERGY", price: 0.49, step_size: 1 }] }],
    });
    expect(draft).toBeDefined();
    expect(draft).not.toHaveProperty("priceIncludesVat");
  });

  test("an element priced for a 2.3.0 booking is restricted to the booking it prices", () => {
    // "When this field is present, the TariffElement describes booking costs":
    // it never prices a session without a booking.
    const tariff = normaliseTariff({
      id: "BOOK",
      currency: "EUR",
      preauthorize_amount: 50,
      elements: [
        {
          price_components: [{ type: "TIME", price: 2, step_size: 60 }],
          restrictions: { booking: "BOOKING" },
        },
        { price_components: [{ type: "ENERGY", price: 0.49, step_size: 1 }] },
      ],
    });
    expect(unreadableTariff(tariff)).toBe(false);
    expect(offer({ ...tariff })).toMatchObject({
      elements: [
        {
          components: [{ type: "time", price: { amount: "2" }, stepSize: 60 }],
          restrictions: { booking: "booking" },
        },
        { components: [{ type: "energy", price: { amount: "0.49" } }] },
      ],
      preauthorizeAmount: { amount: "50", currency: "EUR" },
    });
    // A booking type OCPI does not define cannot be applied as published.
    expect(
      unreadableTariff(
        normaliseTariff({
          ...tariff,
          elements: [{ ...tariff.elements[0], restrictions: { booking: "BOOKING_LATER" } }],
        }),
      ),
    ).toBe(true);
  });

  test("a tariff's energy mix is the offer's: supplier, product, sources and impacts", () => {
    const draft = offer({
      id: "GREEN",
      energy_mix: {
        is_green_energy: true,
        energy_sources: [
          { source: "WIND", percentage: 70 },
          { source: "SOLAR", percentage: 30 },
        ],
        environ_impact: [{ category: "CARBON_DIOXIDE", amount: 0 }],
        supplier_name: "Greenpower",
        energy_product_name: "Green 100",
      },
      elements: [{ price_components: [{ type: "ENERGY", price: 0.49, step_size: 1 }] }],
    });
    expect(draft?.["energyMix"]).toEqual({
      isGreen: true,
      supplierName: "Greenpower",
      productName: "Green 100",
      sources: [
        { source: "wind", pct: 70 },
        { source: "solar", pct: 30 },
      ],
      impacts: [{ category: "carbon_dioxide", gPerKwh: 0 }],
    });
  });

  test("a tariff that states no VAT status writes no priceIncludesVat", () => {
    const draft = offer({
      id: "NA",
      tax_included: "N/A",
      elements: [{ price_components: [{ type: "ENERGY", price: 0.49 }] }],
    });
    expect(draft).toBeDefined();
    expect(draft).not.toHaveProperty("priceIncludesVat");
    expect(
      offer({
        id: "NO",
        tax_included: "NO",
        elements: [{ price_components: [{ type: "ENERGY", price: 0.49 }] }],
      }),
    ).toMatchObject({ priceIncludesVat: false });
  });

  test.each([
    ["an unknown reservation type", { reservation: "BOOKING" }],
    ["only unknown days", { day_of_week: ["FUNDAY"] }],
    ["one unknown day among known ones", { day_of_week: ["SATURDAY", "FUNDAY"] }],
    ["a start time off OCPI's syntax", { start_time: "22.00" }],
    ["an end time off OCPI's syntax", { start_time: "22:00", end_time: "24:00" }],
    ["a start date off OCPI's syntax", { start_date: "2026/01/01" }],
    ["an end date off OCPI's syntax", { end_date: "31.12.2026" }],
    ["a negative minimum", { min_power: -1 }],
    ["a negative maximum", { max_current: -16 }],
    ["a bound that is no number", { max_power: "fast" }],
    ["a property OCPI does not define", { min_soc: 80 }],
    ["restrictions that are no object", "weekends"],
  ])(
    "a restricted element with %s is never applied more widely: the tariff is no offer",
    (_, restrictions) => {
      const draft = offer({
        id: "R",
        elements: [
          { price_components: [{ type: "ENERGY", price: 0.29 }], restrictions },
          { price_components: [{ type: "ENERGY", price: 0.59 }] },
        ],
      });
      expect(draft).toBeUndefined();
      expect(
        unreadableTariff(
          normaliseTariff({
            id: "R",
            currency: "EUR",
            elements: [{ price_components: [{ type: "ENERGY", price: 0.29 }], restrictions }],
          }),
        ),
      ).toBe(true);
    },
  );

  test("an element of unknown dimensions alone leaves the others' order and is not read", () => {
    const tariff = normaliseTariff({
      id: "ORDER",
      currency: "EUR",
      elements: [
        {
          price_components: [{ type: "CONGESTION_TIME", price: 30 }],
          restrictions: { min_soc: 80 },
        },
        {
          price_components: [{ type: "ENERGY", price: 0.29 }],
          restrictions: { day_of_week: ["SATURDAY", "SUNDAY"] },
        },
        { price_components: [{ type: "ENERGY", price: 0.59 }] },
      ],
    });
    expect(unreadableTariff(tariff)).toBe(false);
    expect(offer(tariff as unknown as Record<string, unknown>)).toMatchObject({
      elements: [
        { components: [{ price: { amount: "0.29" } }], restrictions: { days: ["SA", "SU"] } },
        { components: [{ price: { amount: "0.59" } }] },
      ],
    });
  });

  test("a tariff without a priced element the model knows is no offer", () => {
    expect(offer({ id: "EMPTY", elements: [] })).toBeUndefined();
    expect(
      offer({ id: "ODD", elements: [{ price_components: [{ type: "CARBON", price: 1 }] }] }),
    ).toBeUndefined();
  });

  test("a price from 1e21 on is written out in full, not in exponent form", () => {
    const draft = offer({
      id: "HUGE",
      elements: [{ price_components: [{ type: "FLAT", price: 1e21 }] }],
    });
    expect(draft).toMatchObject({
      elements: [{ components: [{ price: { amount: "1000000000000000000000" } }] }],
    });
  });

  test("a step size a double does not hold exactly is not read", () => {
    const draft = offer({
      id: "STEP",
      elements: [{ price_components: [{ type: "TIME", price: 2, step_size: 2 ** 53 }] }],
    });
    expect(draft).toMatchObject({ elements: [{ components: [{ type: "time" }] }] });
    const [element] = (draft?.["elements"] ?? []) as { components: Record<string, unknown>[] }[];
    expect(element?.components[0]).not.toHaveProperty("stepSize");
  });

  test("a validity time past year 9999 is not read", () => {
    const draft = offer({
      id: "FAR",
      start_date_time: "+012026-10-20T10:00:00Z",
      end_date_time: "2027-01-01T00:00:00Z",
      elements: [{ price_components: [{ type: "ENERGY", price: 0.3 }] }],
    });
    expect(draft?.["validity"]).toEqual({ status: "active", end: "2027-01-01T00:00:00Z" });
  });

  test("an alternative text in a malformed language is kept as undetermined", () => {
    const draft = offer({
      id: "LANG",
      tariff_alt_text: [
        { language: "en--gb", text: "Flat fee" },
        { language: "de", text: "Pauschal" },
      ],
      elements: [{ price_components: [{ type: "FLAT", price: 1 }] }],
    });
    expect(draft?.["altText"]).toEqual([
      { lang: "und", text: "Flat fee" },
      { lang: "de", text: "Pauschal" },
    ]);
  });

  test("the offer id reduces the tariff id to safe characters", () => {
    expect(tariffOfferId(FEED, "LOC1", "AC tariff/2 (€)")).toBe(
      "oc:offer:de-test-charging:LOC1:AC_tariff_2____",
    );
  });

  test("the offer and site ids write a station id's line breaks percent-encoded", () => {
    expect(tariffOfferId(FEED, "FI*TSL*\n\u2028", "T1")).toBe(
      "oc:offer:de-test-charging:FI*TSL*%0A%E2%80%A8:T1",
    );
    expect(siteId(FEED, "FI*\r1")).toBe("oc:feature:de-test-charging:FI*%0D1");
  });
});
