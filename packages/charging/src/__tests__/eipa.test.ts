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
import { byReadingId, fullAndStatus } from "./helpers/status-only.js";

// The documentation's example statuses are stamped 2026-07-29.
const FETCHED = "2026-07-29T04:00:00Z";

function parse(payloads: FeedPayloads, fetchedAt = FETCHED): ParseOutput {
  const out = chargingDomain.formats["eipa"]!.parse(
    catalogFeed("pl-eipa-charging"),
    payloads,
    parseContext(fetchedAt),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  details: Record<string, unknown>;
  externalIds?: { scheme: string; id: string }[];
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const site = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:pl-eipa-charging:${id}`);
const evsesOf = (draft: RecordDraft | undefined) =>
  components(draft).filter((c) => c.kind === "evse");
const connectorsOf = (draft: RecordDraft | undefined, evse: string) =>
  components(draft).filter((c) => c.kind === "connector" && c.parentKey === evse);

type Envelope = { data: Record<string, unknown>[]; generated: string };
const json = (name: string) => JSON.parse(fixture(name).toString("utf8")) as Envelope;
const buffer = (doc: unknown) => Buffer.from(JSON.stringify(doc));

function payloads(edit?: (docs: Record<string, Envelope>) => void): FeedPayloads {
  const docs = {
    pools: json("eipa-pool.json"),
    stations: json("eipa-station.json"),
    points: json("eipa-point.json"),
    operators: json("eipa-operator.json"),
    dictionary: json("eipa-dictionary.json"),
    status: json("eipa-dynamic.json"),
  };
  edit?.(docs);
  return Object.fromEntries(Object.entries(docs).map(([role, doc]) => [role, [buffer(doc)]]));
}

describe("eipa", () => {
  beforeEach(() => __resetSkips());

  test("EIPA: a pool with two stations is one site; dynamic prices become an ad-hoc offer", () => {
    const out = parse(
      payloads((docs) => {
        docs["stations"]!.data.push({
          id: 23,
          pool_id: 2,
          type: "E",
          ts: "2026-06-01T14:51:51+02:00",
        });
        docs["points"]!.data.push({
          id: 19,
          code: "PL-2DT-E2NDPOINT",
          station_id: 23,
          connectors: [{ interfaces: [2], cable_attached: true, power: 50 }],
        });
      }),
    );
    // Pool 2 holds stations 22 and 23; the gas station's pool does not exist.
    expect(out.features).toHaveLength(2);
    const pool = site(out, "2");
    expect(evsesOf(pool).map((e) => e.key)).toEqual(["PL*2DT*E2NDPOINT", "PL*2DT*E9FX7M3CL"]);
    expect(evsesOf(pool)[1]).toMatchObject({
      externalIds: [{ scheme: "emi3:evse", id: "PL2DTE9FX7M3CL" }],
      details: { evseId: "PL*2DT*E9FX7M3CL" },
    });
    expect(pool).toMatchObject({
      name: [{ lang: "pl", text: "Centrum Handlowe ABC" }],
      operator: { name: [{ lang: "pl", text: "Operator stacji ładowania Sp. z o.o." }] },
      location: {
        geometry: { type: "Point", coordinates: [16.399548, 52.232128] },
        address: {
          street: "Rycerska",
          houseNumber: "9",
          postalCode: "61-047",
          city: "Poznań",
          country: "PL",
        },
      },
      // Payment 8 is "Płatne ładowanie, gotówka", cash.
      access: { authentication: ["rfid"], payment: ["free", "cash"] },
      details: { directions: [{ lang: "pl", text: "Wejście od ul. Rycerskiej" }] },
    });

    // Point 18 asks 2.54 PLN per kWh and 1.63 PLN per minute, 97.80 PLN an hour.
    expect(out.offers).toHaveLength(2);
    const offer = out.offers.find((o) => (o["subject"] as { id: string }).id === pool?.["id"])!;
    expect(offer).toMatchObject({
      kind: "energy_tariff",
      tariffType: "ad_hoc",
      currency: "PLN",
      altText: [{ lang: "pl", text: "Promocja, 10 min ładowania za darmo" }],
      elements: [
        {
          components: [
            { type: "energy", price: { amount: "2.54", currency: "PLN" }, unit: "kW.h" },
            { type: "time", price: { amount: "97.8", currency: "PLN" }, unit: "h" },
          ],
        },
      ],
    });
    // The register states no VAT status, so the offer states none.
    expect(offer).not.toHaveProperty("priceIncludesVat");
    const refs = connectorsOf(pool, "PL*2DT*E9FX7M3CL").map((c) => c.details["tariffRefs"]);
    expect(refs).toHaveLength(7);
    expect(refs.every((r) => JSON.stringify(r) === JSON.stringify([offer["id"]]))).toBe(true);
    expect(connectorsOf(pool, "PL*2DT*E2NDPOINT")[0]?.details["tariffRefs"]).toBeUndefined();
  });

  test("EIPA: every interface is a connector; a point's availability and occupancy are its status", () => {
    const out = parse(payloads());
    const pool = site(out, "2");
    expect(
      connectorsOf(pool, "PL*2DT*E9FX7M3CL").map((c) => [
        c.key,
        c.details["standard"],
        c.details["format"],
        c.details["maxPowerKw"],
      ]),
    ).toEqual([
      ["PL*2DT*E9FX7M3CL/1.5", "IEC_62196_T2", "cable", 7],
      ["PL*2DT*E9FX7M3CL/1.6", "IEC_62196_T2", "socket", 7],
      ["PL*2DT*E9FX7M3CL/2.1", "DOMESTIC_A", "socket", 57],
      ["PL*2DT*E9FX7M3CL/2.2", "CHADEMO", "socket", 57],
      ["PL*2DT*E9FX7M3CL/2.4", "IEC_62196_T2_COMBO", "socket", 57],
      ["PL*2DT*E9FX7M3CL/2.7", "IEC_62196_T1_COMBO", "socket", 57],
      ["PL*2DT*E9FX7M3CL/2.8", "IEC_62196_T3C", "socket", 57],
    ]);
    const states = out.observations.map((o) => [
      (o["subject"] as { componentKey: string }).componentKey,
      (o["result"] as { value: string }).value,
      (o["phenomenonTime"] as { instant: string }).instant,
    ]);
    expect(states).toEqual([
      // As of each status's own ts.
      ["PL*2DT*E9FX7M3CL", "available", "2026-07-29T03:38:58Z"],
      // Availability 0, "niedostępne": not available, not broken.
      ["PL*V1J*EUEXG3Z5O", "inoperative", "2026-07-29T02:59:00Z"],
    ]);
    const orlen = site(out, "3");
    expect(orlen).toMatchObject({
      operator: { name: [{ lang: "pl", text: "Orlen Charge & Drive Sp. z o.o." }] },
    });
  });

  test("EIPA: a status over thirty days old is no reading, and an occupied point is occupied", () => {
    const late = parse(payloads(), "2026-09-30T04:00:00Z");
    expect(late.observations).toEqual([]);
    const busy = parse(
      payloads((docs) => {
        const row = docs["status"]!.data[0] as { status: { status: number } };
        row.status.status = 0;
      }),
    );
    expect(busy.observations.map((o) => (o["result"] as { value: string }).value)).toEqual([
      "occupied",
      "inoperative",
    ]);
  });

  test("EIPA: the pool's operating hours become OSM hours; gas stations and unplaced pools are skipped", () => {
    const out = parse(
      payloads((docs) => {
        const pool = docs["pools"]!.data[0]!;
        pool["operating_hours"] = [
          { weekday: 1, from_time: "08:00", to_time: "20:00" },
          { weekday: 2, from_time: "08:00", to_time: "20:00" },
          { weekday: 6, from_time: "10:00", to_time: "14:00" },
        ];
        delete docs["pools"]!.data[1]!["latitude"];
      }),
    );
    expect(site(out, "2")).toMatchObject({
      openingHours: { osm: "Mo,Tu 08:00-20:00; Sa 10:00-14:00" },
    });
    expect(site(out, "3")).toBeUndefined();
    expect(drainSkipped("pl-eipa-charging")).toEqual({ no_geometry: 1 });
  });

  test("EIPA: the dynamic file alone, through the full parse's index, gives the full parse's readings", () => {
    const all = payloads();
    const { full, status } = fullAndStatus(
      "eipa",
      catalogFeed("pl-eipa-charging"),
      all,
      parseContext(FETCHED),
    );
    expect(full.observations.length).toBeGreaterThan(0);
    expect(byReadingId(status.observations)).toEqual(byReadingId(full.observations));

    const dynamic = json("eipa-dynamic.json");
    dynamic.data.push({ point_id: 999_999, status: { availability: 1, status: 1 } });
    const unknown = fullAndStatus(
      "eipa",
      catalogFeed("pl-eipa-charging"),
      all,
      parseContext(FETCHED),
      { status: [buffer(dynamic)] },
    );
    expect(unknown.status.observations).toEqual(status.observations);
    expect(unknown.status.rejected).toBe(status.rejected + 1);
  });

  test("EIPA: the Type 3A socket and China's GB/T parts are their OCPI standards", () => {
    const out = parse(
      payloads((docs) => {
        const tables = docs["dictionary"]!.data[0]!;
        (tables["connector_interface"] as unknown[]).push(
          { id: 23, name: "IEC-62196-T3A-F" },
          { id: 31, name: "CHINA-PART2" },
          { id: 32, name: "CHINA-PART3" },
        );
        docs["points"]!.data[1]!["connectors"] = [{ interfaces: [23, 31, 32], power: 22 }];
      }),
    );
    const orlen = site(out, "3");
    expect(
      components(orlen)
        .filter((c) => c.kind === "connector")
        .map((c) => c.details["standard"]),
    ).toEqual(["IEC_62196_T3A", "GBT_AC", "GBT_DC"]);
  });

  test("EIPA: operator contacts and code, province, photos, closures, modes and every method", () => {
    const out = parse(
      payloads((docs) => {
        const pool = docs["pools"]!.data[0]!;
        Object.assign(pool, {
          operating_hours: [{ weekday: 1, from_time: "08:00", to_time: "18:00" }],
          closing_hours: [
            { from_time: "2026-08-01T00:00:00+02:00", to_time: "2026-08-02T00:00:00+02:00" },
          ],
          images: [
            { uri: "https://eipa.example/pool.jpg", thumbnail_uri: "https://eipa.example/t.jpg" },
          ],
          operator_phone: "+48 22 000",
        });
        Object.assign(docs["stations"]!.data[0]!, {
          authentication_methods: [16, 32, 128, 1024, 8192],
          payment_methods: [8, 16, 32],
          images: [{ uri: "https://eipa.example/station.jpg" }],
        });
      }),
    );
    expect(drainSkipped("pl-eipa-charging")).toEqual({});
    const pool = site(out, "2");
    expect(pool).toMatchObject({
      operator: {
        phone: "+48 22 000",
        email: "kontakt@operator.example.pl",
        ids: [{ scheme: "cpo", id: "PL-2DT", authority: "pl-eipa-charging" }],
      },
      location: { address: { region: "wielkopolskie" } },
      images: [
        {
          url: "https://eipa.example/pool.jpg",
          category: "site",
          thumbnail: "https://eipa.example/t.jpg",
        },
      ],
      openingHours: {
        osm: "Mo 08:00-18:00",
        exceptions: [{ start: "2026-07-31T22:00:00Z", end: "2026-08-01T22:00:00Z", open: false }],
      },
      access: {
        authentication: ["pin", "app", "plug_and_charge", "remote"],
        payment: ["cash", "prepaid_card", "other"],
      },
    });
    const point = evsesOf(pool)[0] as Component & { position?: unknown; images?: unknown };
    expect(point.position).toEqual({ type: "Point", coordinates: [16.399548, 52.232128] });
    expect(point.images).toEqual([
      { url: "https://eipa.example/station.jpg", category: "equipment" },
    ]);
    // Mode 4 DC and Mode 3 AC three-phase: modes for each plug, no one power type.
    expect(connectorsOf(pool, point.key)[0]?.details).toMatchObject({
      chargingModes: ["mode4", "mode3"],
    });
    expect(connectorsOf(pool, point.key)[0]?.details).not.toHaveProperty("powerType");
    // "Brak dostępu": not the public's; unknown method and price unit codes are counted.
    const closed = parse(
      payloads((docs) => {
        Object.assign(docs["stations"]!.data[0]!, { authentication_methods: [1, 4096] });
        (docs["status"]!.data[0]!["prices"] as unknown[]).push({ price: "3", unit: "h" });
      }),
    );
    expect(site(closed, "2")).toMatchObject({ access: { audience: "private" } });
    expect(drainSkipped("pl-eipa-charging")).toEqual({ unknown_value: 2 });
  });
});
