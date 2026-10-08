import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  digitrafficStatuses,
  digitrafficTariffs,
  fromDigitraffic,
  normaliseEmi3,
} from "../index.js";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

const features = (
  JSON.parse(fixture("digitraffic-locations.json").toString("utf8")) as {
    features: unknown[];
  }
).features;

describe("fromDigitraffic", () => {
  const locations = fromDigitraffic(features);

  test("camelCase becomes the snake_case wire types", () => {
    const tesla = locations.find((l) => l.party_id === "TSL");
    expect(tesla).toMatchObject({
      id: "1d7c95f5-5924-461e-9d99-ae5396eab63c",
      country_code: "FI",
      party_id: "TSL",
      coordinates: { latitude: 60.388088, longitude: 25.606531 },
      country: "FIN",
    });
    expect(tesla?.evses.map((e) => e.evse_id)).toEqual(["FI*TSL*E5FTM6L", "FI*TSL*E5FTM6K"]);
    expect(tesla?.evses[0]?.connectors[0]).toMatchObject({
      power_type: "DC",
      standard: "IEC_62196_T2_COMBO",
      format: "CABLE",
      max_voltage: expect.any(Number),
      max_amperage: expect.any(Number),
      max_electric_power: 250000,
      tariff_ids: ["e81d652e-a5c7-439c-b0ff-e12fb621e0ce"],
    });
  });

  test("the operator, address and timestamps are mapped", () => {
    const wattery = locations.find((l) => l.party_id === "WTY");
    expect(wattery).toMatchObject({
      id: "347",
      name: "Asunto Oy Lehdespolku 5",
      operator: { name: "Wattery" },
      address: "Lehdespolku 5",
      city: "Vantaa",
      postal_code: "01360",
      last_updated: "2026-09-04T05:27:34.373Z",
    });
  });

  test("an EVSE carries no status of its own and no invented one", () => {
    for (const location of locations) {
      for (const evse of location.evses) expect(evse.status).toBeUndefined();
    }
  });

  test("regular hours get numbered weekdays", () => {
    const hours = locations.find((l) => l.opening_times?.regular_hours !== undefined);
    expect(hours?.opening_times?.twentyfourseven).toBe(false);
    expect(hours?.opening_times?.regular_hours).toContainEqual({
      weekday: 1,
      period_begin: "06:45",
      period_end: "22:15",
    });
    expect(hours?.opening_times?.regular_hours?.map((h) => h.weekday).sort()).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  test("a feature collection and a payload decode like its features", () => {
    expect(
      fromDigitraffic(JSON.parse(fixture("digitraffic-locations.json").toString("utf8"))),
    ).toEqual(locations);
    expect(fromDigitraffic(fixture("digitraffic-locations.json"))).toEqual(locations);
  });

  test("features without an id or coordinates are rejected", () => {
    expect(() => fromDigitraffic([{ type: "Feature", properties: {} }])).toThrow();
  });
});

describe("digitrafficStatuses", () => {
  const statuses = digitrafficStatuses(fixture("digitraffic-statuses.json"));

  test("each status carries the EVSE id and the operator's own timestamp", () => {
    expect(statuses).toHaveLength(9);
    expect(statuses[0]).toEqual({
      evseId: "FI*WTY*E13355*1",
      status: "UNKNOWN",
      at: "2026-09-03T12:54:59.000Z",
    });
  });

  test("statuses join by EVSE id", () => {
    const byEvse = new Map(statuses.map((s) => [normaliseEmi3(s.evseId), s]));
    const locations = fromDigitraffic(features);
    const joined = locations.flatMap((l) =>
      l.evses.map((e) => [e.evse_id, byEvse.get(normaliseEmi3(e.evse_id ?? ""))?.status] as const),
    );
    expect(joined).toEqual([
      ["FI*WTY*E13355*1", "UNKNOWN"],
      ["FI*TSL*E5FTM6L", "AVAILABLE"],
      ["FI*TSL*E5FTM6K", "AVAILABLE"],
      ["FI*PLG*E20207", "AVAILABLE"],
      ["FI*PLG*E20206", "AVAILABLE"],
      ["FI*ABC*E0617*1011*11", "CHARGING"],
      ["FI*ABC*E0617*1011*12", "AVAILABLE"],
      ["FI*LDL*E00000027", "INOPERATIVE"],
      ["FI*LDL*E00000025", "INOPERATIVE"],
    ]);
  });

  test("the time falls back to modifiedAt and entries without an id are dropped", () => {
    const parsed = digitrafficStatuses(
      Buffer.from(
        JSON.stringify({
          statuses: [
            { evseId: "A", status: "AVAILABLE", modifiedAt: "2026-10-01T00:00:00Z" },
            { status: "AVAILABLE" },
            { evseId: "B", status: "CHARGING" },
          ],
        }),
      ),
    );
    expect(parsed).toEqual([
      { evseId: "A", status: "AVAILABLE", at: "2026-10-01T00:00:00Z" },
      { evseId: "B", status: "CHARGING" },
    ]);
  });
});

describe("digitrafficTariffs", () => {
  const tariffs = digitrafficTariffs(fixture("digitraffic-tariffs.json"));

  test("keeps the real tariffAltText and its URL", () => {
    const wattery = tariffs.find((t) => t.id === "FI*WTY*E13355*1-tariff");
    expect(wattery).toMatchObject({
      country_code: "FI",
      party_id: "WTY",
      currency: "EUR",
      type: "AD_HOC_PAYMENT",
      tax_included: "NO",
      tariff_alt_text: [{ language: "fi", text: "Price: 0.23 EUR + spot" }],
      tariff_alt_url: "https://start.wattery.io/fi/num/FI-13355-1",
      last_updated: "2026-10-05T04:00:17.513Z",
    });
    expect(wattery?.elements[0]?.price_components).toEqual([
      { type: "FLAT", price: 0, vat: 0, step_size: 1 },
    ]);
  });

  test("day-of-week, date and duration restrictions are mapped, zero minima dropped", () => {
    const free = tariffs.find((t) => t.party_id === "REC");
    expect(free?.elements[0]?.restrictions).toEqual({ day_of_week: ["WEDNESDAY"] });
    const dated = tariffs.find((t) => t.party_id === "ALL");
    expect(dated?.elements[0]?.restrictions).toEqual({ start_date: "2022-12-31" });
    expect(dated?.tariff_alt_text).toBeUndefined();
    const tesla = tariffs.find((t) => t.party_id === "TSL");
    expect(tesla?.start_date_time).toBe("2026-09-23T21:00:00Z");
    expect(tesla?.elements.map((e) => e.restrictions)).toEqual([
      { max_duration: 300 },
      undefined,
      undefined,
    ]);
    expect(tesla?.elements[0]?.price_components[0]?.type).toBe("CONGESTION_TIME");
  });
});
