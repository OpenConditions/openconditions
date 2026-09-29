import { describe, expect, it } from "vitest";
import { base, feature, observation, ok, registry } from "./network-drafts.js";

describe("tolls", () => {
  const station = feature("toll_point", "bom-1", {
    system: "AutoPASS",
    paymentMethods: ["rfid"],
    passageRule: { window: { value: 3600, unit: "s" }, charged: "first" },
  });
  const small = {
    kind: "classes",
    include: [
      {
        when: [{ dimension: "gross_weight", operator: "lte", value: { value: 3500, unit: "kg" } }],
      },
    ],
  };

  it("registers toll points as sites with an open status", () => {
    expect(ok(station)).toBe(true);
    expect(registry.kind("feature", "toll_point")?.traits).toEqual(["operated_site"]);
  });

  it("prices a toll by vehicle class and time of day as an offer", () => {
    const tariff = {
      ...base("offer", "bom-1/tariff"),
      class: "offer",
      kind: "toll",
      subject: { class: "feature", id: station.id },
      currency: "NOK",
      elements: [
        {
          components: [{ type: "flat", price: { amount: "70.00", currency: "NOK" } }],
          restrictions: { startTime: "06:30", endTime: "09:00", vehicle: small },
        },
        {
          components: [{ type: "flat", price: { amount: "38.00", currency: "NOK" } }],
          restrictions: { vehicle: small },
        },
      ],
      validity: { status: "active" },
    };
    expect(ok(tariff)).toBe(true);
  });

  it("observes a dynamic toll per journey, never per kilometre", () => {
    const section = feature("toll_section", "405tp02896", {
      entryName: [{ lang: "en", text: "SR 524" }],
      exitName: [{ lang: "en", text: "NE 128th" }],
    });
    const price = (per: string, qualifiers?: object) =>
      observation(
        section,
        "toll.price",
        { type: "money", amount: "1.25", currency: "USD", per },
        qualifiers,
      );
    expect(ok(section)).toBe(true);
    expect(ok(price("1"))).toBe(true);
    expect(ok(price("1", { vehicleClass: "truck" }))).toBe(true);
    expect(registry.validateDraft(price("km")).ok).toBe(false);
    expect(registry.validateDraft(price("1", {})).ok).toBe(false);
  });
});
