import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-06T03:00:00Z";

function parse(body: Buffer = fixture("lta-batch.json")): ParseOutput {
  const out = chargingDomain.formats["lta"]!.parse(
    catalogFeed("sg-lta-charging"),
    { main: [body] },
    parseContext(FETCHED, 300),
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
  out.features.find((f) => f["id"] === `oc:feature:sg-lta-charging:${id}`);
const offer = (out: ParseOutput, station: string, tariff: string) =>
  out.offers.find((o) => o["id"] === `oc:offer:sg-lta-charging:${station}:${tariff}`);
const states = (out: ParseOutput) =>
  out.observations.map((o) => [
    (o["subject"] as { featureId: string; componentKey: string }).componentKey,
    (o["result"] as { value: string }).value,
    (o["phenomenonTime"] as { instant: string }).instant,
  ]);

describe("lta", () => {
  test("LTA: per-kWh prices become an SGD energy offer including VAT", () => {
    const out = parse();
    const road = site(out, "123456123456");
    expect(road).toMatchObject({
      name: [{ lang: "en", text: "123 Road A" }],
      operator: { name: [{ lang: "en", text: "EVCO A" }] },
      location: {
        geometry: { type: "Point", coordinates: [103.123456, 1.123456] },
        address: { text: "123 Road A Singapore 123456", postalCode: "123456", country: "SG" },
      },
    });
    const energy = offer(out, "123456123456", "kWh-0.7");
    expect(energy).toMatchObject({
      kind: "energy_tariff",
      subject: { class: "feature", id: "oc:feature:sg-lta-charging:123456123456" },
      currency: "SGD",
      priceIncludesVat: true,
      elements: [
        {
          components: [{ type: "energy", price: { amount: "0.7", currency: "SGD" }, unit: "kW.h" }],
        },
      ],
    });
    expect(components(road)).toEqual([
      { key: "R123456A", kind: "evse", details: { kind: "evse", v: 1 } },
      {
        key: "R123456A/1",
        parentKey: "R123456A",
        kind: "connector",
        details: {
          kind: "connector",
          v: 1,
          standard: "IEC_62196_T2",
          current: "ac",
          maxPowerKw: 7.4,
          tariffRefs: [energy?.["id"]],
        },
      },
    ]);
  });

  test("LTA: per-hour prices are a time offer; a charger is one charge point read by its own status", () => {
    const out = parse();
    const avenue = site(out, "654321654321");
    expect(offer(out, "654321654321", "h-3")).toMatchObject({
      currency: "SGD",
      priceIncludesVat: true,
      elements: [
        { components: [{ type: "time", price: { amount: "3", currency: "SGD" }, unit: "h" }] },
      ],
    });
    // A charger with two evIds is still one charge point, its plug types its connectors.
    expect(
      components(avenue).map((c) => [
        c.key,
        c.details["standard"],
        c.details["current"],
        c.details["maxPowerKw"],
        c.details["tariffRefs"],
      ]),
    ).toEqual([
      ["R654321B", undefined, undefined, undefined, undefined],
      [
        "R654321B/1",
        "IEC_62196_T2_COMBO",
        "dc",
        50,
        ["oc:offer:sg-lta-charging:654321654321:kWh-0.65"],
      ],
      ["R654321B/2", "IEC_62196_T2", "ac", 22, ["oc:offer:sg-lta-charging:654321654321:h-3"]],
      ["R654321C", undefined, undefined, undefined, undefined],
      ["R654321C/1", "IEC_62196_T2", "ac", 22, ["oc:offer:sg-lta-charging:654321654321:h-3"]],
    ]);
    expect(states(out)).toEqual([
      ["R123456A", "available", FETCHED],
      // Two evIds, one occupied and one free: the charger's own 1, available,
      // not the first evId's 0.
      ["R654321B", "available", FETCHED],
      // One evId is the charge point: its 100, not available.
      ["R654321C", "inoperative", FETCHED],
    ]);
    expect(out.offers).toHaveLength(3);
    expect(avenue?.["details"]).toMatchObject({
      openingHoursText: [{ lang: "en", text: "24 hours" }],
    });
  });

  test("LTA: 0 is occupied, which says no more than that the point is in use", () => {
    const doc = JSON.parse(fixture("lta-batch.json").toString("utf8")) as {
      value: { chargingPoints: { evIds: { status: string }[] }[] }[];
    };
    // The charger's one evId is the charge point.
    doc.value[0]!.chargingPoints[0]!.evIds[0]!.status = "0";
    expect(states(parse(Buffer.from(JSON.stringify(doc))))[0]).toEqual([
      "R123456A",
      "occupied",
      FETCHED,
    ]);
  });

  test("LTA: the batch file may be a bare list", () => {
    const doc = JSON.parse(fixture("lta-batch.json").toString("utf8")) as { value: unknown[] };
    const out = parse(Buffer.from(JSON.stringify(doc.value)));
    expect(out.features.map((f) => f["id"])).toEqual([
      "oc:feature:sg-lta-charging:123456123456",
      "oc:feature:sg-lta-charging:654321654321",
    ]);
  });
});
