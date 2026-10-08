import type { RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { parseLayout } from "../formats/layout.js";
import {
  type ChargingFeed,
  connectorStatusDraft,
  evseStatusDraft,
  type SiteInput,
  siteDraft,
} from "../site.js";
import { fixture, hongKongFeed, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FEED: ChargingFeed = {
  id: "de-test-charging",
  format: "ocpi",
  attribution: "Test publisher",
  license: "CC-BY-4.0",
  region: "de",
};
const FETCHED = "2026-10-06T06:00:00Z";

const site = (over: Partial<SiteInput> = {}): RecordDraft => {
  const draft = siteDraft(
    FEED,
    {
      stationId: "LOC1",
      point: [8.4037, 49.0069],
      evses: [
        {
          key: "E1",
          connectors: [
            { id: "1", standard: "IEC_62196_T2", powerType: "AC_3_PHASE", maxPowerKw: 22 },
          ],
        },
        {
          key: "E2",
          connectors: [{ id: "1", standard: "IEC_62196_T2_COMBO", powerType: "DC" }],
        },
      ],
      ...over,
    },
    FETCHED,
  );
  expect(sealFailures([draft])).toEqual([]);
  return draft;
};

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  externalIds?: { scheme: string; id: string; authority?: string }[];
  details: Record<string, unknown>;
};
const components = (draft: RecordDraft) => draft["components"] as Component[];
const component = (draft: RecordDraft, key: string) => components(draft).find((c) => c.key === key);

describe("siteDraft", () => {
  test("two EVSEs with connector id '1' each give two distinct connector components", () => {
    const draft = site();
    expect(components(draft).map((c) => [c.kind, c.key, c.parentKey])).toEqual([
      ["evse", "E1", undefined],
      ["connector", "E1/1", "E1"],
      ["evse", "E2", undefined],
      ["connector", "E2/1", "E2"],
    ]);
    // Each status reading names its own connector.
    const ctx = { fetchedAt: FETCHED, cadenceSec: 300 };
    const readings = [
      connectorStatusDraft(
        FEED,
        { stationId: "LOC1", evseKey: "E1", connectorId: "1", status: "charging", at: FETCHED },
        ctx,
      )!,
      connectorStatusDraft(
        FEED,
        { stationId: "LOC1", evseKey: "E2", connectorId: "1", status: "available", at: FETCHED },
        ctx,
      )!,
    ];
    expect(sealFailures(readings)).toEqual([]);
    expect(readings.map((r) => r["subject"])).toEqual([
      { kind: "feature", featureId: "oc:feature:de-test-charging:LOC1", componentKey: "E1/1" },
      { kind: "feature", featureId: "oc:feature:de-test-charging:LOC1", componentKey: "E2/1" },
    ]);
    expect(new Set(readings.map((r) => r["id"])).size).toBe(2);
  });

  test("current comes from the power type unless the source states it", () => {
    const draft = site({
      evses: [
        {
          key: "E1",
          connectors: [
            { id: "1", standard: "IEC_62196_T2", powerType: "AC_1_PHASE" },
            { id: "2", standard: "CHADEMO", powerType: "DC" },
            { id: "3", standard: "IEC_62196_T2", current: "ac" },
            { id: "4", standard: "DOMESTIC_F" },
          ],
        },
      ],
    });
    expect(component(draft, "E1/1")?.details).toMatchObject({
      powerType: "AC_1_PHASE",
      current: "ac",
    });
    expect(component(draft, "E1/2")?.details).toMatchObject({ powerType: "DC", current: "dc" });
    expect(component(draft, "E1/3")?.details).toMatchObject({ current: "ac" });
    expect(component(draft, "E1/4")?.details).not.toHaveProperty("current");
    expect(component(draft, "E1/4")?.details).not.toHaveProperty("format");
  });

  test("a standard the model does not know is UNKNOWN, and power that is not positive is absent", () => {
    const draft = site({
      evses: [
        {
          key: "E1",
          connectors: [{ id: "1", standard: "TYPE_2_SOMETHING", maxPowerKw: 0, maxVoltage: -1 }],
        },
      ],
    });
    expect(component(draft, "E1/1")?.details).toEqual({
      kind: "connector",
      v: 1,
      standard: "UNKNOWN",
    });
  });

  test("eMI3 ids are normalised and carry no authority; the operator's uid stays a detail", () => {
    const draft = site({
      evses: [
        {
          key: "uid-1",
          uid: "uid-1",
          evseId: "de*muc*e 123",
          capabilities: ["RFID_READER"],
          parkingRestrictions: ["ev_only", "nonsense"],
          connectors: [{ id: "1", standard: "IEC_62196_T2" }],
        },
      ],
    });
    expect(component(draft, "uid-1")).toMatchObject({
      externalIds: [{ scheme: "emi3:evse", id: "DEMUCE123" }],
      details: {
        evseId: "de*muc*e 123",
        uid: "uid-1",
        capabilities: ["RFID_READER"],
        parkingRestrictions: ["ev_only"],
      },
    });
    expect(component(draft, "uid-1")?.externalIds?.[0]).not.toHaveProperty("authority");
  });

  test("an evseId that is no eMI3 id is neither an id nor a detail", () => {
    const draft = site({
      evses: [
        { key: "p1", evseId: "Ladepunkt 1", connectors: [] },
        // Thirty-two characters after the E: one more than eMI3 allows.
        { key: "p2", evseId: "DE*MUC*E12345678901234567890123456789012", connectors: [] },
      ],
    });
    for (const key of ["p1", "p2"]) {
      expect(component(draft, key)?.externalIds).toBeUndefined();
      expect(component(draft, key)?.details).not.toHaveProperty("evseId");
    }
  });

  test("a register-only EVSE carries quantity and no reading", () => {
    const draft = site({
      evses: [
        { key: "type2", quantity: 4, connectors: [{ id: "1", standard: "IEC_62196_T2" }] },
        { key: "single", quantity: 1, connectors: [{ id: "1", standard: "IEC_62196_T2" }] },
      ],
    });
    expect(component(draft, "type2")?.details).toMatchObject({ quantity: 4 });
    expect(component(draft, "single")?.details).not.toHaveProperty("quantity");
    // A count register (Hong Kong) gives grouped charge points and no status.
    const out = parseLayout(
      hongKongFeed(),
      { main: [fixture("hk-epd.geojson")] },
      parseContext(FETCHED),
    );
    expect(out.observations).toEqual([]);
    expect(
      out.features.flatMap((f) => components(f)).some((c) => c.details["quantity"] !== undefined),
    ).toBe(true);
  });

  test("component keys never hold '#', EVSE keys never '/', and a repeated key keeps the first", () => {
    const draft = site({
      evses: [
        { key: "A#1", connectors: [{ id: "1#a", standard: "IEC_62196_T2" }] },
        { key: "A#1", connectors: [{ id: "9", standard: "CHADEMO" }] },
        // Would otherwise be the key of the connector above.
        { key: "A_1/1_a", connectors: [{ id: "1", standard: "CHADEMO" }] },
      ],
    });
    expect(components(draft).map((c) => c.key)).toEqual(["A_1", "A_1/1_a", "A_1_1_a", "A_1_1_a/1"]);
  });

  test("a connector status lands on the component siteDraft created, whatever the source ids hold", () => {
    for (const [evse, connector] of [
      ["A", "1"],
      [" B#2/x ", " 1#b "],
    ] as const) {
      const draft = site({
        evses: [{ key: evse, connectors: [{ id: connector, standard: "IEC_62196_T2" }] }],
      });
      const reading = connectorStatusDraft(
        FEED,
        {
          stationId: "LOC1",
          evseKey: evse,
          connectorId: connector,
          status: "charging",
          at: FETCHED,
        },
        { fetchedAt: FETCHED },
      );
      const evseReading = evseStatusDraft(
        FEED,
        { stationId: "LOC1", evseKey: evse, status: "charging", at: FETCHED },
        { fetchedAt: FETCHED },
      );
      const keys = components(draft).map((c) => c.key);
      expect(keys).toContain((reading["subject"] as { componentKey: string }).componentKey);
      expect(keys).toContain((evseReading["subject"] as { componentKey: string }).componentKey);
      expect(
        component(draft, (reading["subject"] as { componentKey: string }).componentKey)?.kind,
      ).toBe("connector");
    }
  });

  test("connector tariffs become the ids of the site's offers", () => {
    const draft = site({
      evses: [
        {
          key: "E1",
          connectors: [{ id: "1", standard: "IEC_62196_T2", tariffIds: ["T 1", "AC/2", "T 1"] }],
        },
      ],
    });
    expect(component(draft, "E1/1")?.details["tariffRefs"]).toEqual([
      "oc:offer:de-test-charging:LOC1:T_1",
      "oc:offer:de-test-charging:LOC1:AC_2",
    ]);
  });

  test("the site carries its provider id, organisations, access and text details", () => {
    const draft = site({
      name: "Ladepark Mitte",
      lang: "de",
      operator: { name: "EnBW", website: "https://www.enbw.com", wikidata: "Q541380" },
      owner: { name: "Stadt Karlsruhe" },
      brand: "EnBW",
      website: "www.example.org/laden",
      address: {
        street: "Kaiserstraße",
        houseNumber: "1",
        postalCode: "76133",
        city: "Karlsruhe",
        country: "DEU",
      },
      twentyFourSeven: true,
      audience: "public",
      payment: ["credit_card", "app"],
      authentication: ["rfid"],
      parkingType: "on_street",
      tariffText: "0,59 €/kWh",
      notes: "Zufahrt über den Hof",
      amenities: ["cafe"],
      lifecycle: "planned",
      upstream: [{ publisher: "Upstream CPO", license: "CC0-1.0" }],
    });
    expect(draft).toMatchObject({
      id: "oc:feature:de-test-charging:LOC1",
      class: "feature",
      kind: "charging_site",
      lifecycle: "planned",
      name: [{ lang: "de", text: "Ladepark Mitte" }],
      description: [{ lang: "de", text: "Zufahrt über den Hof" }],
      operator: {
        role: "operator",
        name: [{ lang: "de", text: "EnBW" }],
        website: "https://www.enbw.com",
        ids: [{ scheme: "wikidata", id: "Q541380" }],
      },
      owner: { role: "owner", name: [{ lang: "de", text: "Stadt Karlsruhe" }] },
      openingHours: { osm: "24/7", twentyFourSeven: true },
      access: { audience: "public", payment: ["credit_card", "app"], authentication: ["rfid"] },
      amenities: ["cafe"],
      externalIds: [{ scheme: "provider", id: "LOC1", authority: "de-test-charging" }],
      location: {
        address: {
          street: "Kaiserstraße",
          houseNumber: "1",
          postalCode: "76133",
          city: "Karlsruhe",
          country: "DE",
        },
        admin: { country: "DE" },
      },
      provenance: {
        sourceId: "de-test-charging",
        sourceFormat: "ocpi",
        upstream: [{ publisher: "Upstream CPO", license: "CC0-1.0" }],
      },
      details: {
        kind: "charging_site",
        v: 1,
        brand: "EnBW",
        website: "https://www.example.org/laden",
        parkingType: "on_street",
        tariffText: [{ lang: "de", text: "0,59 €/kWh" }],
      },
    });
  });

  test("an aggregator names the upstream as authority; OSM sites carry no provider id", () => {
    expect(site({ providerAuthority: "de-test-charging/chargecloud" })["externalIds"]).toEqual([
      { scheme: "provider", id: "LOC1", authority: "de-test-charging/chargecloud" },
    ]);
    expect(
      site({ providerId: false, externalIds: [{ scheme: "osm:node", id: "42" }] })["externalIds"],
    ).toEqual([{ scheme: "osm:node", id: "42" }]);
  });

  test("an unknown alpha-3 country falls back to the feed's region", () => {
    const draft = site({ address: { city: "Karlsruhe", country: "XXX" } });
    expect(draft["location"]).toMatchObject({ address: { city: "Karlsruhe", country: "DE" } });
  });
});

describe("status readings", () => {
  test("a status reading is dated by its publisher and states no validity of its own", () => {
    const at = "2026-10-03T05:58:00Z";
    const r = { stationId: "LOC1", evseKey: "E1", status: "available" as const, at };
    const reading = evseStatusDraft(FEED, r, { fetchedAt: FETCHED })!;
    expect(sealFailures([reading])).toEqual([]);
    expect(reading).toMatchObject({
      property: "charging.evse_status",
      subject: {
        kind: "feature",
        featureId: "oc:feature:de-test-charging:LOC1",
        componentKey: "E1",
      },
      result: { type: "category", value: "available", vocabulary: "evse_status" },
      phenomenonTime: { instant: at },
    });
    // Its source's polling, when read, says how long it holds.
    expect(reading).not.toHaveProperty("validUntil");
  });

  test("the phenomenon time is the UTC instant, whatever offset the source wrote", () => {
    const reading = evseStatusDraft(
      FEED,
      { stationId: "LOC1", evseKey: "E1", status: "occupied", at: "2026-10-06T07:58:00.000+02:00" },
      { fetchedAt: FETCHED },
    )!;
    expect(reading["phenomenonTime"]).toEqual({ instant: "2026-10-06T05:58:00Z" });
  });

  test("a status without a readable time, or with one after the fetch, is read at the fetch", () => {
    const at = (time: string | undefined) =>
      evseStatusDraft(
        FEED,
        {
          stationId: "LOC1",
          evseKey: "E1",
          status: "available",
          ...(time === undefined ? {} : { at: time }),
        },
        { fetchedAt: FETCHED },
      )!["phenomenonTime"];
    expect(at(undefined)).toEqual({ instant: "2026-10-06T06:00:00Z" });
    expect(at("yesterday")).toEqual({ instant: "2026-10-06T06:00:00Z" });
    expect(at("2026-10-06T06:05:00Z")).toEqual({ instant: "2026-10-06T06:00:00Z" });
  });
});
