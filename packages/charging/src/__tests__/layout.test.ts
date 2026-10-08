import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { parseLayout } from "../formats/layout.js";
import {
  fixture,
  flandersFeed,
  hongKongFeed,
  nswFeed,
  parseContext,
  victoriaFeed,
  walloniaFeed,
} from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-06T02:15:00Z";

function parse(feed: ChargingCatalogFeed, file: string): ParseOutput {
  const out = parseLayout(feed, { main: [fixture(file)] }, parseContext(FETCHED, 86400));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  // A register publishes no live state.
  expect(out.observations).toEqual([]);
  expect(out.offers).toEqual([]);
  return out;
}

const site = (out: ParseOutput, stationId: string) => {
  const found = out.features.find((f) => String(f["id"]).endsWith(`-charging:${stationId}`));
  if (found === undefined) throw new Error(`no site ${stationId}`);
  return found;
};

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  details: Record<string, unknown>;
};
const components = (draft: RecordDraft) => (draft["components"] ?? []) as Component[];

/** A site's charge points: key, quantity and their connectors' details without the envelope. */
function evses(draft: RecordDraft) {
  const all = components(draft);
  return all
    .filter((c) => c.kind === "evse")
    .map((evse) => ({
      key: evse.key,
      ...(evse.details["quantity"] === undefined ? {} : { quantity: evse.details["quantity"] }),
      connectors: all
        .filter((c) => c.parentKey === evse.key)
        .map(
          ({ key, details: { kind: _kind, v: _v, ...rest } }): Record<string, unknown> => ({
            key,
            ...rest,
          }),
        ),
    }));
}

describe("geojson", () => {
  test("Flanders: rows of one location become one site with an EVSE per row and maximaal_vermogen_kw as power", () => {
    const out = parse(flandersFeed(), "be-vlg-mow.json");
    expect(out.features).toHaveLength(3);
    expect(out.rejected).toBe(0);
    const herent = site(out, "a4d397a0-54ad-11ec-80be-42010a840003");
    expect(herent).toMatchObject({
      kind: "charging_site",
      lifecycle: "operational",
      operator: { role: "operator", name: [{ lang: "nl", text: "Mobiflow" }] },
      access: { audience: "restricted" },
      externalIds: [
        {
          scheme: "provider",
          id: "a4d397a0-54ad-11ec-80be-42010a840003",
          authority: "be-vlg-mow-charging",
        },
      ],
      location: {
        geometry: { type: "Point", coordinates: [4.668648, 50.90203604] },
        address: { street: "Kouterstraat 17", postalCode: "3020", city: "Herent", country: "BE" },
      },
    });
    const ac = {
      standard: "IEC_62196_T2",
      powerType: "AC_3_PHASE",
      current: "ac",
      maxPowerKw: 22,
    };
    expect(evses(herent)).toEqual([
      { key: "98597135", connectors: [{ key: "98597135/1", ...ac }] },
      { key: "98597136", connectors: [{ key: "98597136/1", ...ac }] },
    ]);
    const dc = {
      standard: "IEC_62196_T2_COMBO",
      powerType: "DC",
      current: "dc",
      maxPowerKw: 40,
    };
    expect(evses(site(out, "8c7d64a2-7496-11f1-9d05-42010aa400b8"))).toEqual([
      { key: "112402428", connectors: [{ key: "112402428/1", ...dc }] },
      { key: "112402427", connectors: [{ key: "112402427/1", ...dc }] },
    ]);
    expect(site(out, "ff248c18-84d3-11f1-967e-42010aa400b8")).toMatchObject({
      access: { audience: "public" },
    });
  });

  test("Flanders: a location split across pages is still one site", () => {
    const doc = JSON.parse(fixture("be-vlg-mow.json").toString("utf8")) as { features: unknown[] };
    const page = (features: unknown[]) => Buffer.from(JSON.stringify({ ...doc, features }));
    const out = parseLayout(
      flandersFeed(),
      { main: [page(doc.features.slice(0, 1)), page(doc.features.slice(1))] },
      parseContext(FETCHED),
    );
    expect(out.features).toHaveLength(3);
    expect(evses(site(out, "a4d397a0-54ad-11ec-80be-42010a840003"))).toHaveLength(2);
  });

  test("Hong Kong: count columns become EVSEs with quantity by standard", () => {
    const out = parse(hongKongFeed(), "hk-epd.geojson");
    expect(out.features).toHaveLength(3);
    const yuen = site(out, "Yuen Chau Kok Complex");
    expect(yuen).toMatchObject({
      name: [{ lang: "en", text: "Yuen Chau Kok Complex" }],
      location: { address: { text: "35 Ngan Shing Street, Sha Tin", country: "HK" } },
    });
    expect(evses(yuen)).toEqual([
      {
        key: "STANDARD_BS1363_no",
        connectors: [
          { key: "STANDARD_BS1363_no/1", standard: "DOMESTIC_G", format: "socket", current: "ac" },
        ],
      },
      {
        key: "MEDIUM_IEC62196_no",
        quantity: 10,
        connectors: [{ key: "MEDIUM_IEC62196_no/1", standard: "IEC_62196_T2", current: "ac" }],
      },
    ]);
    const elements = evses(site(out, "ELEMENTS Carpark"));
    expect(elements.map((e) => [e.key, e.quantity, e.connectors[0]?.["standard"]])).toEqual([
      ["MEDIUM_IEC62196_no", 9, "IEC_62196_T2"],
      ["QUICK_CHAdeMO_no", 3, "CHADEMO"],
      ["QUICK_CCS_DC_COMBO_no", 21, "IEC_62196_T2_COMBO"],
      ["QUICK_IEC62196_no", 67, "IEC_62196_T2"],
      ["QUICK_GB_T20234_3_DC__no", 6, "GBT_DC"],
      ["FAST_CCS_DC_COMBO_no", 6, "IEC_62196_T2_COMBO"],
    ]);
    // The tiers are ranges, so no connector claims a power.
    expect(
      out.features.flatMap(components).some((c) => c.details["maxPowerKw"] !== undefined),
    ).toBe(false);
  });

  test("Victoria: '1 x CCS2, 1 x CHAdeMO' on one charger gives one EVSE with two connectors; 'CCS2' alone gives one", () => {
    const out = parse(victoriaFeed(), "au-vic.geojson");
    // The record with every property null has no id.
    expect(out.features).toHaveLength(5);
    expect(out.rejected).toBe(1);
    const tatura = site(out, "104 Hogan Street, TATURA VIC 3614");
    expect(tatura).toMatchObject({
      name: [{ lang: "en", text: "Tatura" }],
      operator: { name: [{ lang: "en", text: "Tatura Carwash" }] },
    });
    // `chargers` "1 x 25kW Charger": one charge point with both plugs.
    const dc25 = { current: "dc", maxPowerKw: 25 };
    expect(evses(tatura)).toEqual([
      {
        key: "1",
        connectors: [
          { key: "1/1", standard: "IEC_62196_T2_COMBO", ...dc25 },
          { key: "1/2", standard: "CHADEMO", ...dc25 },
        ],
      },
    ]);
    // "2 x 60kW" with the plug "CCS2": two identical charge points.
    expect(evses(site(out, "30 Howitt Avenue, Eastwood, VIC 3875"))).toEqual([
      {
        key: "1",
        quantity: 2,
        connectors: [{ key: "1/1", standard: "IEC_62196_T2_COMBO", current: "dc", maxPowerKw: 60 }],
      },
    ]);
    const cranbourne =
      "Melbourne City Football Club - 369 Casey Fields Blvd, Cranbourne East VIC 3977";
    expect(evses(site(out, cranbourne))).toEqual([
      {
        key: "1",
        quantity: 2,
        connectors: [{ key: "1/1", standard: "IEC_62196_T2", current: "ac", maxPowerKw: 22 }],
      },
    ]);
    const kerang = evses(site(out, "Albert St (Car Park), KERANG VIC 3579"));
    expect(kerang).toHaveLength(1);
    expect(kerang[0]?.connectors.map((c) => [c["standard"], c["maxPowerKw"]])).toEqual([
      ["CHADEMO", 50],
      ["IEC_62196_T2_COMBO", 50],
    ]);
    // An empty plug list keeps the published charger with a plug it does not name.
    expect(evses(site(out, "1 McMillan St, Anglesea VIC 3230"))).toEqual([
      { key: "1", connectors: [{ key: "1/1", standard: "UNKNOWN", maxPowerKw: 50 }] },
    ]);
  });

  test("Victoria: a site to be completed after the fetch is planned", () => {
    const out = parse(victoriaFeed(), "au-vic.geojson");
    // " November 2026" lies after the fetch (2026-10-06), " July 2025" before it.
    expect(site(out, "30 Howitt Avenue, Eastwood, VIC 3875")["lifecycle"]).toBe("planned");
    expect(site(out, "1 McMillan St, Anglesea VIC 3230")["lifecycle"]).toBe("operational");
    expect(site(out, "104 Hogan Street, TATURA VIC 3614")["lifecycle"]).toBe("operational");
    const doc = JSON.parse(fixture("au-vic.geojson").toString("utf8")) as {
      features: { properties: Record<string, unknown> }[];
    };
    const completing = (when: string) => {
      const [tatura] = doc.features;
      const feature = {
        ...tatura,
        properties: { ...tatura!.properties, estimated_project_completion: when },
      };
      const parsed = parseLayout(
        victoriaFeed(),
        { main: [Buffer.from(JSON.stringify({ ...doc, features: [feature] }))] },
        parseContext(FETCHED),
      );
      return parsed.features[0]?.["lifecycle"];
    };
    expect(completing("31/10/2026")).toBe("planned");
    expect(completing("05/10/2026")).toBe("operational");
    expect(completing("6 October 2026")).toBe("operational");
    expect(completing("7 October 2026")).toBe("planned");
    expect(completing("October 2026")).toBe("planned");
    expect(completing("September 2026")).toBe("operational");
    expect(completing("soon")).toBe("operational");
  });

  test("Victoria: plugs without chargers are one charge point; neither is a site without components", () => {
    const doc = JSON.parse(fixture("au-vic.geojson").toString("utf8")) as {
      features: { properties: Record<string, unknown> }[];
    };
    const [tatura, anglesea] = doc.features;
    const features = [
      { ...tatura, properties: { ...tatura!.properties, chargers: null } },
      { ...anglesea, properties: { ...anglesea!.properties, chargers: "" } },
    ];
    const out = parseLayout(
      victoriaFeed(),
      { main: [Buffer.from(JSON.stringify({ ...doc, features }))] },
      parseContext(FETCHED),
    );
    expect(sealFailures(out.features)).toEqual([]);
    expect(evses(site(out, "104 Hogan Street, TATURA VIC 3614"))).toEqual([
      {
        key: "1",
        connectors: [
          { key: "1/1", standard: "IEC_62196_T2_COMBO", current: "dc" },
          { key: "1/2", standard: "CHADEMO", current: "dc" },
        ],
      },
    ]);
    expect(site(out, "1 McMillan St, Anglesea VIC 3230")).not.toHaveProperty("components");
  });
});

describe("csv", () => {
  test("Wallonia: an EPSG:31370 WKT point lands in Namur", () => {
    const out = parse(walloniaFeed(), "be-wal-spw.csv");
    // The row without an EMPLACEMENT_ID is rejected.
    expect(out.features).toHaveLength(4);
    expect(out.rejected).toBe(1);
    const namur = site(out, "89b3a26e-f841-11ee-b689-42010aa400b8");
    const [lon, lat] = (namur["location"] as { geometry: { coordinates: [number, number] } })
      .geometry.coordinates;
    expect(Math.abs(lon - 4.858691)).toBeLessThan(1e-5);
    expect(Math.abs(lat - 50.469649)).toBeLessThan(1e-5);
    expect(namur).toMatchObject({
      operator: { name: [{ lang: "fr", text: "50 five" }] },
      access: { audience: "restricted" },
      location: {
        address: {
          street: "Boulevard de Merckem 60",
          postalCode: "5000",
          city: "Namur",
          country: "BE",
        },
      },
      details: { parkingType: "on_street" },
    });
    // No plug standard is published, so none is claimed.
    expect(evses(namur)).toEqual([
      { key: "67409491", connectors: [{ key: "67409491/1", standard: "UNKNOWN", maxPowerKw: 22 }] },
      { key: "67409492", connectors: [{ key: "67409492/1", standard: "UNKNOWN", maxPowerKw: 22 }] },
    ]);
    const tournai = site(out, "f9ac76b8-4f3c-11e8-a7df-42010a840002");
    expect(tournai).not.toHaveProperty("operator");
    expect(tournai).toMatchObject({
      access: { audience: "public" },
      details: { parkingType: "parking_garage" },
    });
  });

  test("NSW: 'Upcoming' is a planned site; '2x350kW & 2x175kW' gives two EVSE groups of 350 and 175 kW", () => {
    const out = parse(nswFeed(), "au-nsw.csv");
    expect(out.features).toHaveLength(7);
    const ourimbah = site(out, "-33.353198,151.369027,NRMA Electric");
    expect(ourimbah).toMatchObject({
      lifecycle: "planned",
      operator: { name: [{ lang: "en", text: "NRMA Electric" }] },
      location: {
        geometry: { coordinates: [151.369027, -33.353198] },
        address: { text: "129 Pacific Hwy Ourimbah NSW 2258 Australia", country: "AU" },
      },
    });
    expect(ourimbah).not.toHaveProperty("name");
    expect(evses(ourimbah)).toEqual([
      { key: "1", quantity: 2, connectors: [{ key: "1/1", standard: "UNKNOWN", maxPowerKw: 350 }] },
      { key: "2", quantity: 2, connectors: [{ key: "2/1", standard: "UNKNOWN", maxPowerKw: 175 }] },
    ]);
    // A plug count is not a count of charge points: a single rating is one.
    expect(site(out, "-31.557629,143.386007,NRMA")).toMatchObject({ lifecycle: "operational" });
    expect(evses(site(out, "-31.557629,143.386007,NRMA"))).toEqual([
      {
        key: "1",
        connectors: [{ key: "1/1", standard: "UNKNOWN", current: "dc", maxPowerKw: 50 }],
      },
    ]);
    // Three operators at one point are three sites.
    const figtree = out.features.filter((f) => String(f["id"]).includes(":-34.436615,150.863298,"));
    expect(figtree).toHaveLength(3);
    const grove = site(out, "-34.436615,150.863298,Non-networked");
    expect(grove).not.toHaveProperty("operator");
    expect(grove).toMatchObject({ name: [{ lang: "en", text: "Figtree Grove Shopping Centre" }] });
    // An `AC` rating names no power.
    expect(evses(grove)).toEqual([
      { key: "1", connectors: [{ key: "1/1", standard: "UNKNOWN", current: "ac" }] },
    ]);
    // A bare number is kW.
    const dulwich = evses(site(out, "-33.909859,151.141688,EVE Australia"));
    expect(dulwich[0]?.connectors[0]).toMatchObject({ maxPowerKw: 22 });
  });

  test("NSW: one operator's rows a few metres apart are one site", () => {
    const lines = fixture("au-nsw.csv").toString("utf8").split("\n");
    // The Wilcannia charger listed again 4 m north, as a row per charger.
    const again = lines[2]!.replace("-31.557629", "-31.557593").replace(/^16,/, "17,");
    const out = parse(nswFeed(), "au-nsw.csv");
    const both = parseLayout(
      nswFeed(),
      { main: [Buffer.from([...lines.slice(0, 3), again, ...lines.slice(3)].join("\n"))] },
      parseContext(FETCHED, 86400),
    );
    expect(both.features).toHaveLength(out.features.length);
    const wilcannia = both.features.filter((f) => String(f["id"]).includes(",143.386007,NRMA"));
    expect(wilcannia.map((f) => f["id"])).toEqual([
      "oc:feature:au-nsw-tfnsw-charging:-31.557593,143.386007,NRMA",
    ]);
    expect(evses(wilcannia[0]!).map((e) => e.key)).toEqual(["1", "-31.557629,143.386007,NRMA:1"]);
  });
});

describe("edge records", () => {
  test("a row without its EVSE key never takes the key of another charge point", () => {
    const header =
      "OBJECTID;CONNECTEUR_ID;EMPLACEMENT_ID;OPERATEUR;ADRESSE;CODE_POSTAL;VILLE;PROVINCE;TYPE_ACCES;TYPE_EMPLACEMENT;RESTRICTIONS_EMPLACEMENT;PUISSANCE_KW;TYPE_RECHARGE;DISTANCE_SORTIE_METRE;DISTANCE_AUTOROUTE_METRE;DATETRANS;WKT_GEOM\n";
    const row = (connector: string, kw: string) =>
      `"1";"${connector}";"loc";"Op";"Rue 1";"5000";"Namur";"Namur";"public";"ON_STREET";"";"${kw}";"Normal";"1";"1";"2026-04-10T00:00:00";"POINT (184781.2 128873.1)"\n`;
    const csv = header + row("", "11") + row("1", "22");
    const out = parseLayout(walloniaFeed(), { main: [Buffer.from(csv)] }, parseContext(FETCHED));
    expect(sealFailures(out.features)).toEqual([]);
    expect(evses(site(out, "loc")).map((e) => [e.key, e.connectors[0]?.["maxPowerKw"]])).toEqual([
      ["row-1", 11],
      ["1", 22],
    ]);
  });

  test("a record without a placeable point is rejected", () => {
    const feed = nswFeed();
    const csv =
      "OBJECTID,Station_name,Station_address,Operator,Number_of_plugs,Charger_Type,Charger_rating,Latitude,Longitude,LGANAME,PCODE,Source\n" +
      "1,,Somewhere,NRMA,2,AC,22 kW,,,,,\n";
    const out = parseLayout(feed, { main: [Buffer.from(csv)] }, parseContext(FETCHED));
    expect(out.features).toEqual([]);
    expect(out.rejected).toBe(1);
  });
});
