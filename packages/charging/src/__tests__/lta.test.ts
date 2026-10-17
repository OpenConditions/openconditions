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
      {
        key: "R123456A-001",
        kind: "evse",
        physicalReference: "L1 Lot 123",
        details: { kind: "evse", v: 1 },
      },
      {
        key: "R123456A-001/1",
        parentKey: "R123456A-001",
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

  test("LTA: per-hour prices are a time offer; each evId is a charge point read by its own status", () => {
    const out = parse();
    const avenue = site(out, "654321654321");
    expect(offer(out, "654321654321", "h-3")).toMatchObject({
      currency: "SGD",
      priceIncludesVat: true,
      elements: [
        { components: [{ type: "time", price: { amount: "3", currency: "SGD" }, unit: "h" }] },
      ],
    });
    // A charger's evIds, "individual charging points", are each a charge point with its plugs.
    const kwh = ["oc:offer:sg-lta-charging:654321654321:kWh-0.65"];
    const hour = ["oc:offer:sg-lta-charging:654321654321:h-3"];
    expect(
      components(avenue).map((c) => [
        c.key,
        c.details["standard"],
        c.details["current"],
        c.details["maxPowerKw"],
        c.details["tariffRefs"],
      ]),
    ).toEqual([
      ["R654321B-001", undefined, undefined, undefined, undefined],
      ["R654321B-001/1", "IEC_62196_T2_COMBO", "dc", 50, kwh],
      ["R654321B-001/2", "IEC_62196_T2", "ac", 22, hour],
      ["R654321B-002", undefined, undefined, undefined, undefined],
      ["R654321B-002/1", "IEC_62196_T2_COMBO", "dc", 50, kwh],
      ["R654321B-002/2", "IEC_62196_T2", "ac", 22, hour],
      ["R654321C-001", undefined, undefined, undefined, undefined],
      ["R654321C-001/1", "IEC_62196_T2", "ac", 22, hour],
    ]);
    expect(states(out)).toEqual([
      ["R123456A-001", "available", FETCHED],
      // Each point by its own status: one occupied, one free.
      ["R654321B-001", "occupied", FETCHED],
      ["R654321B-002", "available", FETCHED],
      // Not available covers out of order, inoperative and unknown alike.
      ["R654321C-001", "unknown", FETCHED],
    ]);
    expect(out.offers).toHaveLength(3);
    expect(avenue).toMatchObject({ openingHours: { osm: "24/7", twentyFourSeven: true } });
  });

  test("LTA: an empty status is not available, and a charger without evIds is its own point", () => {
    const doc = JSON.parse(fixture("lta-batch.json").toString("utf8")) as {
      value: { chargingPoints: Record<string, unknown>[] }[];
    };
    const charger = doc.value[0]!.chargingPoints[0]!;
    (charger["evIds"] as { status: string }[])[0]!.status = "";
    const charger2 = doc.value[1]!.chargingPoints[1]!;
    delete charger2["evIds"];
    charger2["status"] = "0";
    const read = states(parse(Buffer.from(JSON.stringify(doc))));
    expect(read).toContainEqual(["R123456A-001", "unknown", FETCHED]);
    expect(read).toContainEqual(["R654321C", "occupied", FETCHED]);
  });

  test("LTA: 0 is occupied, which says no more than that the point is in use", () => {
    const doc = JSON.parse(fixture("lta-batch.json").toString("utf8")) as {
      value: { chargingPoints: { evIds: { status: string }[] }[] }[];
    };
    // The charger's one evId is the charge point.
    doc.value[0]!.chargingPoints[0]!.evIds[0]!.status = "0";
    expect(states(parse(Buffer.from(JSON.stringify(doc))))[0]).toEqual([
      "R123456A-001",
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
