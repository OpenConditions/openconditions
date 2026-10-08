import { normaliseTariff } from "@openconditions/ocpi";
import { describe, expect, test } from "vitest";
import type { ChargingFeed } from "../site.js";
import { tariffDraft, tariffOfferId } from "../tariff.js";
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

  test("min_price keeps excl_vat; max_duration 0 sets no maxDuration", () => {
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

  test("a tariff without a priced element the model knows is no offer", () => {
    expect(offer({ id: "EMPTY", elements: [] })).toBeUndefined();
    expect(
      offer({ id: "ODD", elements: [{ price_components: [{ type: "CARBON", price: 1 }] }] }),
    ).toBeUndefined();
  });

  test("the offer id reduces the tariff id to safe characters", () => {
    expect(tariffOfferId(FEED, "LOC1", "AC tariff/2 (€)")).toBe(
      "oc:offer:de-test-charging:LOC1:AC_tariff_2____",
    );
  });
});
