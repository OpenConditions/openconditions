import { emptyParseOutput, type RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { colocateSites } from "../colocate.js";
import { type ChargingFeed, evseStatusDraft, type SiteInput, siteDraft } from "../site.js";
import { tariffDraft } from "../tariff.js";
import { parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FEED: ChargingFeed = {
  id: "lt-test-charging",
  format: "ocpi",
  attribution: "Test publisher",
  license: "CC-BY-4.0",
  region: "lt",
};
const FETCHED = "2026-10-06T06:00:00Z";
const ctx = parseContext(FETCHED);

/** `metres` north of Savanorių pr. 28, Vilnius. */
const north = (metres: number): [number, number] => [25.2556, 54.6826 + metres / 111_195];

const input = (stationId: string, metres: number, over: Partial<SiteInput> = {}): SiteInput => ({
  stationId,
  point: north(metres),
  operator: { name: "Stuart Energy" },
  address: { street: "Savanorių pr.", houseNumber: "28", city: "Vilnius" },
  evses: [{ key: "1", connectors: [{ id: "1", standard: "IEC_62196_T2" }] }],
  ...over,
});

function output(sites: SiteInput[]) {
  const out = emptyParseOutput();
  for (const site of sites) {
    out.features.push(siteDraft(FEED, site, FETCHED));
    const reading = evseStatusDraft(
      FEED,
      { stationId: site.stationId, evseKey: "1", status: "available", at: FETCHED },
      ctx,
    );
    if (reading !== undefined) out.observations.push(reading);
  }
  return out;
}

type Component = { key: string; parentKey?: string; kind: string; lifecycle?: string };
const ids = (drafts: readonly RecordDraft[]) => drafts.map((d) => d["id"]);
const components = (draft: RecordDraft) => draft["components"] as Component[];

describe("colocateSites", () => {
  test("one operator's locations within 15 m are one site named by the lowest id", () => {
    const out = colocateSites(
      output([
        input("LT*STR*15472", 0),
        input("LT*STR*15428", 4),
        input("LT*STR*15500", 10, { name: "Savanorių 28" }),
      ]),
    );
    expect(ids(out.features)).toEqual(["oc:feature:lt-test-charging:LT*STR*15428"]);
    const [site] = out.features as [RecordDraft];
    expect(site["name"]).toEqual([{ lang: "und", text: "Savanorių 28" }]);
    expect(site["externalIds"]).toEqual([
      { scheme: "provider", id: "LT*STR*15428", authority: "lt-test-charging" },
      { scheme: "provider", id: "LT*STR*15472", authority: "lt-test-charging" },
      { scheme: "provider", id: "LT*STR*15500", authority: "lt-test-charging" },
    ]);
    // Every location keyed its charge point "1": the later ones take their location's id.
    expect(components(site).map((c) => [c.key, c.parentKey])).toEqual([
      ["1", undefined],
      ["1/1", "1"],
      ["LT*STR*15472:1", undefined],
      ["LT*STR*15472:1/1", "LT*STR*15472:1"],
      ["LT*STR*15500:1", undefined],
      ["LT*STR*15500:1/1", "LT*STR*15500:1"],
    ]);
    expect(
      out.observations.map((o) => (o["subject"] as { componentKey: string }).componentKey).sort(),
    ).toEqual(["1", "LT*STR*15472:1", "LT*STR*15500:1"]);
    expect(
      new Set(out.observations.map((o) => (o["subject"] as { featureId: string }).featureId)),
    ).toEqual(new Set([site["id"]]));
    expect(new Set(out.observations.map((o) => o["id"])).size).toBe(3);
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });

  test("finds a neighbour 12 m north far from the prime meridian (Sydney)", () => {
    // At -33.99994 a column width read at each point's own latitude puts them two columns apart.
    for (const lat of [-34, -33.99994, -33.87, -37.81]) {
      const at = (metres: number): [number, number] => [151.2093, lat + metres / 111_195];
      const out = colocateSites(
        output([input("A", 0, { point: at(0) }), input("B", 0, { point: at(12) })]),
      );
      expect(ids(out.features), String(lat)).toEqual(["oc:feature:lt-test-charging:A"]);
    }
  });

  test("orders ids by their numbers, so 9 comes before 10", () => {
    const out = colocateSites(output([input("10", 0), input("9", 3)]));
    expect(ids(out.features)).toEqual(["oc:feature:lt-test-charging:9"]);
  });

  test("keeps apart other operators, sites further than 15 m, and two house numbers", () => {
    const out = colocateSites(
      output([
        input("A", 0),
        input("B", 3, { operator: { name: "Eldrive" } }),
        input("C", 20),
        input("D", 5, { address: { street: "Savanorių pr.", houseNumber: "30" } }),
        input("E", 6, { operator: undefined }),
        input("F", 7, { operator: undefined }),
      ]),
    );
    expect(ids(out.features)).toEqual(
      ["A", "B", "C", "D", "E", "F"].map((id) => `oc:feature:lt-test-charging:${id}`),
    );
  });

  test("never chains: every member stands within 15 m of every other", () => {
    const out = colocateSites(output([input("A", 0), input("B", 10), input("C", 20)]));
    expect(ids(out.features)).toEqual([
      "oc:feature:lt-test-charging:A",
      "oc:feature:lt-test-charging:C",
    ]);
  });

  test("never merges two issuers' locations of one aggregator", () => {
    const out = colocateSites(
      output([
        input("1", 0, { providerAuthority: "agg/bnetza_api" }),
        input("2", 3, { providerAuthority: "agg/datex2_enbw" }),
      ]),
    );
    expect(out.features).toHaveLength(2);
  });

  test("a site in service stays in service; a member's other state goes on its charge points", () => {
    const out = colocateSites(output([input("A", 0, { lifecycle: "planned" }), input("B", 3)]));
    const [site] = out.features as [RecordDraft];
    expect(site["lifecycle"]).toBe("operational");
    expect(components(site).filter((c) => c.kind === "evse")).toEqual([
      expect.objectContaining({ key: "1", lifecycle: "planned" }),
      expect.objectContaining({ key: "B:1", lifecycle: "operational" }),
    ]);
  });

  test("one charge point two locations list is kept once", () => {
    const evse = { key: "LT*STR*E1", evseId: "LT*STR*E1", connectors: [] };
    const out = colocateSites(
      output([input("A", 0, { evses: [evse] }), input("B", 3, { evses: [evse] })]),
    );
    expect(components(out.features[0]!).map((c) => c.key)).toEqual(["LT*STR*E1"]);
  });

  test("hours, audience and parking type stay only where every location states them alike", () => {
    const out = colocateSites(
      output([
        input("A", 0, { twentyFourSeven: true, audience: "public", payment: ["app"] }),
        input("B", 3, { audience: "customers", payment: ["rfid"] }),
      ]),
    );
    const [site] = out.features as [RecordDraft];
    expect(site["openingHours"]).toBeUndefined();
    expect(site["access"]).toEqual({ audience: "unknown", payment: ["app", "rfid"] });
  });

  test("moves the tariffs and readings of every location onto the site", () => {
    const out = output([input("A", 0), input("B", 3)]);
    const offer = tariffDraft(
      FEED,
      "B",
      {
        id: "T1",
        currency: "EUR",
        elements: [{ price_components: [{ type: "ENERGY", price: 0.39 }] }],
      },
      { fetchedAt: FETCHED, point: north(3) },
    );
    out.offers.push(offer!);
    colocateSites(out);
    expect(out.offers.map((o) => [o["id"], (o["subject"] as { id: string }).id])).toEqual([
      ["oc:offer:lt-test-charging:B:T1", "oc:feature:lt-test-charging:A"],
    ]);
    expect(sealFailures([...out.features, ...out.offers])).toEqual([]);
  });
});
