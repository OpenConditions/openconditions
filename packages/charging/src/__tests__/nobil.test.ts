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

const FETCHED = "2026-10-06T02:45:56Z";

function parse(payloads: FeedPayloads): ParseOutput {
  const out = chargingDomain.formats["nobil"]!.parse(
    catalogFeed("no-nobil-charging"),
    payloads,
    parseContext(FETCHED),
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
  out.features.find((f) => f["id"] === `oc:feature:no-nobil-charging:${id}`);
const evsesOf = (draft: RecordDraft | undefined) =>
  components(draft).filter((c) => c.kind === "evse");
const connectorsOf = (draft: RecordDraft | undefined, evse: string) =>
  components(draft).filter((c) => c.kind === "connector" && c.parentKey === evse);

const dump = () => parse({ main: [fixture("nobil.json")] });

describe("nobil", () => {
  beforeEach(() => __resetSkips());

  test("NOBIL: the datadump object parses into sites with one EVSE per connector", () => {
    const out = dump();
    expect(out.features).toHaveLength(2);
    // The documented example: a Schuko outlet on a six-point station; counts are
    // not invented, so only the connector the record describes is an EVSE.
    const ikea = site(out, "NOR_00041");
    expect(evsesOf(ikea).map((e) => e.key)).toEqual(["1"]);
    expect(connectorsOf(ikea, "1")[0]).toMatchObject({
      key: "1/1",
      details: {
        standard: "DOMESTIC_F",
        format: "socket",
        powerType: "AC_1_PHASE",
        current: "ac",
        maxVoltage: 230,
        maxAmperage: 16,
        // Capacity 7 is "3,6 kW - 230V 1-phase max 16A".
        maxPowerKw: 3.6,
        chargingModes: ["mode1"],
      },
    });
    // Every value the documentation's records write is one NOBIL lists.
    expect(drainSkipped("no-nobil-charging")).toEqual({});
    expect(ikea).toMatchObject({
      lifecycle: "operational",
      name: [{ lang: "no", text: "IKEA Slependen" }],
      owner: { name: [{ lang: "no", text: "IKEA" }] },
      location: {
        geometry: { type: "Point", coordinates: [10.49982, 59.87447] },
        address: {
          street: "Nesbruveien",
          houseNumber: "40",
          postalCode: "1396",
          city: "BILLINGSTAD",
          country: "NO",
        },
      },
      openingHours: { osm: "24/7", twentyFourSeven: true },
      access: { audience: "public", authentication: ["none"] },
    });
    expect(ikea?.["externalIds"]).toEqual([
      { scheme: "provider", id: "NOR_00041", authority: "no-nobil-charging" },
    ]);
  });

  test("NOBIL: a station's connectors are keyed by their index or their EVSE id, each with its plugs and kW", () => {
    const out = dump();
    const fast = site(out, "NOR_09001");
    expect(evsesOf(fast).map((e) => e.key)).toEqual(["2", "NO*EKS*E9001*1"]);
    expect(evsesOf(fast)[1]).toMatchObject({
      externalIds: [{ scheme: "emi3:evse", id: "NOEKSE90011" }],
    });
    expect(connectorsOf(fast, "NO*EKS*E9001*1")[0]?.details).toMatchObject({
      standard: "IEC_62196_T2_COMBO",
      format: "cable",
      powerType: "DC",
      current: "dc",
      maxVoltage: 500,
      maxAmperage: 100,
      maxPowerKw: 50,
    });
    // "Type 2 + Schuko" is two plugs on one point; the 22 kW rating is the Type 2's.
    expect(connectorsOf(fast, "2").map((c) => c.details)).toEqual([
      expect.objectContaining({
        standard: "IEC_62196_T2",
        powerType: "AC_3_PHASE",
        maxPowerKw: 22,
      }),
      { kind: "connector", v: 1, standard: "DOMESTIC_F", format: "socket", current: "ac" },
    ]);
    expect(fast).toMatchObject({
      access: { audience: "customers", authentication: ["rfid"] },
    });
    expect(fast?.["openingHours"]).toBeUndefined();
    expect(out.observations).toEqual([]);
  });

  test("NOBIL: Station_status is the lifecycle, and a deactivated station is decommissioned", () => {
    const doc = JSON.parse(fixture("nobil.json").toString("utf8")) as {
      chargerstations: { csmd: Record<string, unknown> }[];
    };
    const [first, second] = doc.chargerstations as [
      { csmd: Record<string, unknown> },
      { csmd: Record<string, unknown> },
    ];
    first.csmd["Station_status"] = 2;
    second.csmd["Active"] = false;
    const out = parse({ main: [Buffer.from(JSON.stringify(doc))] });
    expect(site(out, "NOR_00041")).toMatchObject({ lifecycle: "unknown" });
    expect(site(out, "NOR_09001")).toMatchObject({ lifecycle: "decommissioned" });
  });

  test("NOBIL: attributes are read by their value ids, the station's photo, county, comment and real-time flag", () => {
    const attribute = (id: string, valueId: string, value = "") => ({
      attrtypeid: id,
      attrvalid: valueId,
      trans: "ignored",
      attrval: value,
    });
    const doc = {
      chargerstations: [
        {
          csmd: {
            id: 7,
            International_id: "NOR_00007",
            name: "Test",
            Position: "(59.9,10.7)",
            Land_code: "NOR",
            County: "Oslo",
            Station_status: 1,
            Description_of_location: "Ved inngangen",
            User_comment: "Tilgjengelig 07-16",
            Image: "7.jpg",
          },
          attr: {
            st: {
              "2": attribute("2", "5"),
              "3": attribute("3", "6"),
              "21": attribute("21", "1"),
              "24": attribute("24", "2"),
            },
            conn: {
              "1": {
                "1": attribute("1", "6"),
                "4": attribute("4", "32"),
                "5": attribute("5", "17"),
                "19": attribute("19", "21"),
                "20": attribute("20", "3"),
                "23": attribute("23", "6", "Zaptec"),
                "25": attribute("25", "2"),
                "29": attribute("29", "9", "A"),
              },
              "2": { "4": attribute("4", "39"), "26": attribute("26", "2") },
            },
          },
        },
      ],
    };
    const out = parse({ main: [Buffer.from(JSON.stringify(doc))] });
    expect(drainSkipped("no-nobil-charging")).toEqual({});
    const station = site(out, "NOR_00007");
    expect(station).toMatchObject({
      location: { address: { region: "Oslo" } },
      description: [{ lang: "no", text: "Tilgjengelig 07-16" }],
      images: [{ url: "https://nobil.no/img/ladestasjonbilder/7.jpg", category: "site" }],
      access: {
        audience: "private",
        authentication: ["app"],
        payment: ["credit_card", "debit_card", "rfid"],
      },
      amenities: ["hotel", "restaurant"],
      details: {
        dynamicInfoAvailable: "true",
        directions: [{ lang: "no", text: "Ved inngangen" }],
      },
    });
    expect(station?.["openingHours"]).toBeUndefined();
    // The hydrogen entry is no charge point; the residents' one is restricted to tenants.
    expect(evsesOf(station).map((e) => e.details)).toEqual([
      expect.objectContaining({ parkingRestrictions: ["tenants"], manufacturer: "Zaptec" }),
    ]);
    // 230 V three-phase is Norway's IT grid: √3 × 230 V × 32 A.
    expect(connectorsOf(station, "1")[0]).toMatchObject({
      key: "1/A",
      details: {
        standard: "IEC_62196_T2",
        format: "socket",
        powerType: "AC_3_PHASE",
        maxPowerKw: 12.748,
        chargingModes: ["mode3"],
      },
    });
    // A value id NOBIL does not list, a status it does not document.
    const odd = structuredClone(doc);
    odd.chargerstations[0]!.csmd.Station_status = 3;
    odd.chargerstations[0]!.attr.st["2"] = attribute("2", "9");
    odd.chargerstations[0]!.attr.conn["1"]["5"] = attribute("5", "toString");
    parse({ main: [Buffer.from(JSON.stringify(odd))] });
    expect(drainSkipped("no-nobil-charging")).toEqual({ unknown_value: 3 });
  });

  test("NOBIL: a datadump wrapped in a list, and a station without a position, are read as documented", () => {
    const doc = JSON.parse(fixture("nobil.json").toString("utf8")) as {
      chargerstations: { csmd: Record<string, unknown> }[];
    };
    doc.chargerstations[1]!.csmd["Position"] = "";
    const out = parse({ main: [Buffer.from(JSON.stringify([doc]))] });
    expect(out.features).toHaveLength(1);
    expect(drainSkipped("no-nobil-charging")).toEqual({ no_geometry: 1 });
  });
});
