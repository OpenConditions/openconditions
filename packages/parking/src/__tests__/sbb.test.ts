import type { ParseOutput } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { parseSbb } from "../formats/sbb.js";
import { fixture, parseContext, sbbFeed } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-05T04:04:17Z";

const CASTIONE = "f35490f4-f622-4881-90d0-f4041bdeef78";
const REALP = "6e189b1d-1424-41f2-92f7-efc2daa960de";
const RHYHALDE = "ef3699d3-2e29-431d-ad4b-df64551c2caa";
const DIETLIKON = "6935079d-baaa-4f13-a1f5-2ce83941b307";
const HERISAU = "0057697d-defb-4ce6-94fa-6c0a14bb5372";
const BIKE = "6b868d5e-f242-4543-b904-0473e27f01c0";

function parse(): ParseOutput {
  const out = parseSbb(
    sbbFeed(),
    { main: [fixture("sbb-parking.json")] },
    parseContext(FETCHED, 86400),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => f["id"] === `oc:feature:ch-sbb-parking:${stationId}`);

const areas = (out: ParseOutput, stationId: string) =>
  (
    (site(out, stationId)?.["components"] ?? []) as {
      key: string;
      details: { capacity?: number };
    }[]
  ).map((c) => [c.key, c.details.capacity]);

type Element = {
  components: { type: string; price: { amount: string; currency: string }; stepSize?: number }[];
  restrictions?: {
    minDuration?: { value: number; unit: string };
    maxDuration?: { value: number; unit: string };
    userGroups?: string[];
  };
};

const quantity = (q: { value: number; unit: string } | undefined) =>
  q === undefined ? undefined : `${q.value} ${q.unit}`;

/** `[type, amount, step in s, from, until, user groups]` of each element of a site's rate. */
const rows = (out: ParseOutput, stationId: string) =>
  (
    (out.offers.find((o) => o["id"] === `oc:offer:ch-sbb-parking:${stationId}:1`)?.["elements"] ??
      []) as Element[]
  ).map((e) => [
    e.components[0]?.type,
    e.components[0]?.price.amount,
    e.components[0]?.stepSize,
    quantity(e.restrictions?.minDuration),
    quantity(e.restrictions?.maxDuration),
    e.restrictions?.userGroups,
  ]);

describe("sbb", () => {
  test("SBB: disabled and charging capacities are areas, not added to the total", () => {
    const out = parse();
    expect(site(out, CASTIONE)).toMatchObject({
      type: "park_and_ride",
      name: [{ lang: "und", text: "Castione-Arbedo" }],
      details: { capacityTotal: 200, usage: ["park_and_ride"] },
    });
    expect(areas(out, CASTIONE)).toEqual([
      ["car:any", 200],
      ["car:disabled", 4],
      ["car:ev_charging", 2],
    ]);
    // Categories published as 0 are no areas.
    expect(areas(out, RHYHALDE)).toEqual([["car:any", 20]]);
    expect(site(out, RHYHALDE)).toMatchObject({ type: "off_street" });
  });

  test("SBB: only car facilities are sites", () => {
    const out = parse();
    expect(out.features).toHaveLength(5);
    expect(site(out, BIKE)).toBeUndefined();
  });

  test("SBB: price segments are prices per increment, from their start to the next", () => {
    const out = parse();
    // 100 centimes per 60-minute increment, with an 800-centime day maximum.
    expect(rows(out, CASTIONE)).toEqual([
      ["parking_time", "1.00", 3600, "0 min", undefined, undefined],
      ["flat", "8.00", undefined, undefined, "1 d", undefined],
      ["flat", "60.00", undefined, undefined, "1 mo", ["monthly_ticket"]],
      ["flat", "600.00", undefined, undefined, "1 a", ["yearly_ticket"]],
    ]);
    // 5 centimes per 6-minute increment.
    expect(rows(out, RHYHALDE)).toEqual([
      ["parking_time", "0.50", 360, "0 min", undefined, undefined],
      ["flat", "12.00", undefined, undefined, "1 d", undefined],
    ]);
    // CHF 1.00 per hour for five hours, then free.
    expect(rows(out, REALP)).toEqual([
      ["parking_time", "1.00", 3600, "0 min", "300 min", undefined],
      ["parking_time", "0.00", 3600, "300 min", undefined, undefined],
    ]);
    // CHF 1.00 per hour for six hours, free in the seventh, then CHF 2.00 per hour.
    expect(rows(out, HERISAU)).toEqual([
      ["parking_time", "1.00", 3600, "0 min", "360 min", undefined],
      ["parking_time", "0.00", 3600, "360 min", "420 min", undefined],
      ["parking_time", "2.00", 3600, "420 min", undefined, undefined],
      ["flat", "8.00", undefined, undefined, "1 d", undefined],
    ]);
    expect(rows(out, DIETLIKON)).toEqual([
      ["parking_time", "1.00", 3600, "0 min", undefined, undefined],
      ["flat", "8.00", undefined, undefined, "1 d", undefined],
      ["flat", "50.00", undefined, undefined, "1 mo", ["monthly_ticket"]],
      [
        "flat",
        "50.00",
        undefined,
        undefined,
        "1 mo",
        ["monthly_ticket", "public_transport_season_ticket"],
      ],
      ["flat", "500.00", undefined, undefined, "1 a", ["yearly_ticket"]],
      [
        "flat",
        "500.00",
        undefined,
        undefined,
        "1 a",
        ["yearly_ticket", "public_transport_season_ticket"],
      ],
    ]);
    expect(out.offers[0]).toMatchObject({ currency: "CHF", kind: "parking_rate" });
  });

  test("SBB: one span on the listed days becomes OSM opening hours", () => {
    const out = parse();
    expect(site(out, CASTIONE)).toMatchObject({
      openingHours: { osm: "24/7", twentyFourSeven: true },
    });
    expect(site(out, REALP)).toMatchObject({ openingHours: { osm: "Mo-Su 07:15-02:00" } });
    expect(site(out, RHYHALDE)).toMatchObject({ openingHours: { osm: "Mo-Sa 08:00-18:00" } });
  });

  test("SBB: the estimated occupancy is a percentage, never a count of free spaces", () => {
    const out = parse();
    const of = (stationId: string) =>
      out.observations.filter(
        (o) =>
          (o["subject"] as { featureId: string }).featureId ===
          `oc:feature:ch-sbb-parking:${stationId}`,
      );
    expect(of(CASTIONE).map((o) => [o["property"], o["result"]])).toEqual([
      ["parking.occupancy_pct", { type: "quantity", value: 39.856285, unit: "%" }],
    ]);
    expect(of(CASTIONE)[0]?.["phenomenonTime"]).toEqual({ instant: FETCHED });
    // An estimate dated at the daily poll goes stale within the hour, not after two days.
    expect(of(CASTIONE)[0]?.["validUntil"]).toBe("2026-10-05T05:04:17.000Z");
    expect(of(REALP)).toEqual([]);
  });

  test("SBB: address, operator, website and access are kept", () => {
    const out = parse();
    expect(site(out, CASTIONE)).toMatchObject({
      location: {
        geometry: { coordinates: [9.04154158, 46.22479428] },
        address: {
          street: "Via Stazione 9",
          postalCode: "6532",
          city: "Castione-Arbedo",
          country: "CH",
        },
      },
      operator: { name: [{ text: "SBB" }] },
      access: { audience: "public" },
      details: { website: expect.stringMatching(/^https:\/\/www\.sbb\.ch\/en\//) },
    });
  });
});
