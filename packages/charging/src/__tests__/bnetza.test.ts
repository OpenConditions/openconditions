import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-06T02:45:56Z";

function parse(payloads: FeedPayloads): ParseOutput {
  const out = chargingDomain.formats["bnetza"]!.parse(
    catalogFeed("de-bnetza-charging"),
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
  lifecycle?: string;
  details: Record<string, unknown>;
  externalIds?: { scheme: string; id: string }[];
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const site = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:de-bnetza-charging:${id}`);
const evsesOf = (draft: RecordDraft | undefined) =>
  components(draft).filter((c) => c.kind === "evse");
const connectorsOf = (draft: RecordDraft | undefined, evse: string) =>
  components(draft).filter((c) => c.kind === "connector" && c.parentKey === evse);

const register = () => parse({ main: [fixture("bnetza.csv")] });

describe("bnetza", () => {
  test("BNetzA: six charge points of one device are six EVSEs with their plugs and power", () => {
    const out = register();
    // The ten preamble lines and the BOM are skipped; every row below the header is a site.
    expect(out.features).toHaveLength(12);
    const device = site(out, "1149546");
    expect(evsesOf(device).map((e) => e.key)).toEqual([
      "DE*811*E135202CD*1001",
      "DE*811*E135202CD*1002",
      "DE*811*E135202CD*1003",
      "DE*811*E135202CD*1004",
      "DE*811*E135202CD*1005",
      "DE*811*E135202CD*1006",
    ]);
    const first = evsesOf(device)[0]!;
    expect(first.externalIds).toEqual([{ scheme: "emi3:evse", id: "DE811E135202CD1001" }]);
    expect(first.details).toMatchObject({ evseId: "DE*811*E135202CD*1001" });
    expect(connectorsOf(device, "DE*811*E135202CD*1006")[0]).toMatchObject({
      key: "DE*811*E135202CD*1006/1",
      details: { standard: "IEC_62196_T2", format: "socket", current: "ac", maxPowerKw: 22 },
    });
    // The register names no site here: the operator is no name.
    expect(device?.["name"]).toBeUndefined();
    expect(device).toMatchObject({
      lifecycle: "operational",
      operator: { name: [{ lang: "de", text: "Robert Bosch GmbH" }] },
      location: {
        geometry: { type: "Point", coordinates: [9.146977, 48.698116] },
        address: {
          street: "Max-Lang-Straße",
          houseNumber: "40-46",
          postalCode: "70771",
          city: "Leinfelden-Echterdingen",
          country: "DE",
        },
      },
      access: { audience: "customers" },
    });
    // "Keine Angabe" is no opening hours.
    expect(device?.["openingHours"]).toBeUndefined();
    // A register publishes no states: nothing is read live, and the commissioning
    // date is no update time.
    expect(out.observations).toEqual([]);
    expect(device?.["freshness"]).toEqual({ fetchedAt: FETCHED });
  });

  test("BNetzA: a plug list is the connectors of one EVSE, each with its own power", () => {
    const out = register();
    const two = site(out, "1142486");
    expect(evsesOf(two)).toHaveLength(1);
    expect(connectorsOf(two, "DEQRMEMJPPC11").map((c) => c.details)).toEqual([
      expect.objectContaining({ standard: "IEC_62196_T2", format: "cable", maxPowerKw: 11 }),
      expect.objectContaining({ standard: "IEC_62196_T2", format: "socket", maxPowerKw: 22 }),
    ]);
    expect(two).toMatchObject({
      openingHours: { osm: "24/7", twentyFourSeven: true },
      access: {
        audience: "public",
        payment: ["credit_card", "contactless", "debit_card", "app", "rfid"],
      },
    });
    const mega = site(out, "1150139");
    expect(connectorsOf(mega, "1150139-1").map((c) => c.details)).toEqual([
      expect.objectContaining({ standard: "MCS", current: "dc", maxPowerKw: 1000 }),
      expect.objectContaining({ standard: "IEC_62196_T2_COMBO", current: "dc", maxPowerKw: 600 }),
    ]);
  });

  test("BNetzA: 'In Wartung' is temporarily closed and no reading is written", () => {
    const out = register();
    const closed = site(out, "1084823");
    expect(closed).toMatchObject({ lifecycle: "temporarily_closed" });
    expect(site(out, "1010338")).toMatchObject({ lifecycle: "operational" });
    expect(out.observations).toEqual([]);
    // No EVSE id: the point's key is the device and its slot.
    expect(evsesOf(closed).map((e) => e.key)).toEqual(["1084823-1", "1084823-2"]);
    expect(evsesOf(closed)[0]?.externalIds).toBeUndefined();
  });

  test("BNetzA: opening hours from the weekday and time lists; a plug the model lacks stays unknown", () => {
    const out = register();
    expect(site(out, "1125796")).toMatchObject({
      openingHours: { osm: "Mo-Su 06:00-22:00" },
    });
    // Three-pole and five-pole CEE carry no amperage in the register.
    const cee = site(out, "1137340");
    expect(connectorsOf(cee, "1137340-1").map((c) => c.details)).toEqual([
      expect.objectContaining({ standard: "UNKNOWN", current: "ac", powerType: "AC_3_PHASE" }),
      expect.objectContaining({ standard: "IEC_62196_T2_COMBO", current: "dc" }),
    ]);
    // A free-text cell in the EVSE-ID column is no eMI3 id.
    const junk = site(out, "1148160");
    expect(evsesOf(junk)[0]).toMatchObject({ key: "1148160-1" });
    expect(evsesOf(junk)[0]?.details["evseId"]).toBeUndefined();
    expect(site(out, "1085129")).toMatchObject({
      access: { payment: ["free"] },
    });
  });

  test("BNetzA: points beyond the six slots are one undifferentiated EVSE of their count", () => {
    const header =
      "Ladeeinrichtungs-ID;Betreiber;Status;Anzahl Ladepunkte;Breitengrad;Längengrad;Steckertypen1;Nennleistung Stecker1;EVSE-ID1";
    const row = "77;Beispiel GmbH;In Betrieb;9;50,1;8,5;DC CHAdeMO;50;DEXMPE0001";
    const out = parse({ main: [Buffer.from(`${header}\r\n${row}\r\n`)] });
    const wide = site(out, "77");
    expect(evsesOf(wide).map((e) => [e.key, e.details["quantity"]])).toEqual([
      ["DEXMPE0001", undefined],
      ["77-2", undefined],
      ["77-3", undefined],
      ["77-4", undefined],
      ["77-5", undefined],
      ["77-6", undefined],
      ["77-more", 3],
    ]);
  });

  test("BNetzA: the devices of one operator within 15 m are one site, unless their house numbers differ", () => {
    const header =
      "Ladeeinrichtungs-ID;Betreiber;Anzeigename (Karte);Status;Anzahl Ladepunkte;Straße;Hausnummer;Breitengrad;Längengrad;Informationen zum Parkraum;Bezahlsysteme;Steckertypen1;Nennleistung Stecker1;EVSE-ID1";
    const rows = [
      "905;Stadtwerke Beispiel;;In Wartung;1;Markt;1;49,0094;8,4044;Nur für Kunden/Besucher;Kostenlos;AC Typ 2 Steckdose;22;",
      "88;Stadtwerke Beispiel;Marktplatz;In Betrieb;1;Markt;1;49,0094;8,4044;Keine Beschränkung;RFID-Karte;AC Typ 2 Steckdose;11;",
      "91;Andere GmbH;;In Betrieb;1;Markt;1;49,0094;8,4044;;;DC CHAdeMO;50;",
      "93;Stadtwerke Beispiel;;In Betrieb;1;Markt;;49,0095;8,4044;;;AC Typ 2 Steckdose;11;",
      "94;Stadtwerke Beispiel;;In Betrieb;1;Markt;3;49,0094;8,4044;;;AC Typ 2 Steckdose;11;",
      "92;Stadtwerke Beispiel;;In Betrieb;1;Markt;;49,0096;8,4044;;;AC Typ 2 Steckdose;11;",
      // A device listed twice is the same device, no malformed row.
      "91;Andere GmbH;;In Betrieb;1;Markt;1;49,0094;8,4044;;;DC CHAdeMO;50;",
    ];
    const out = parse({ main: [Buffer.from(`${header}\r\n${rows.join("\r\n")}\r\n`)] });
    expect(out.rejected).toBe(0);
    // The other operator, the other house number and the device 22 m away stay
    // sites of their own; the device 11 m away joins.
    expect(out.features.map((f) => f["id"]).sort()).toEqual([
      "oc:feature:de-bnetza-charging:88",
      "oc:feature:de-bnetza-charging:91",
      "oc:feature:de-bnetza-charging:92",
      "oc:feature:de-bnetza-charging:94",
    ]);
    // The site takes the lowest device id; every device id stays matchable.
    const shared = site(out, "88");
    const ids = (shared?.["externalIds"] ?? []) as { scheme: string; id: string }[];
    expect(ids.filter((e) => e.scheme === "bnetza")).toEqual([
      { scheme: "bnetza", id: "88" },
      { scheme: "bnetza", id: "93" },
      { scheme: "bnetza", id: "905" },
    ]);
    expect(evsesOf(shared).map((e) => [e.key, e.lifecycle])).toEqual([
      ["88-1", "operational"],
      ["93-1", "operational"],
      ["905-1", "temporarily_closed"],
    ]);
    // One device in service keeps the site in service; the access the devices
    // disagree on is not stated, the payments of both are.
    expect(shared).toMatchObject({
      name: [{ lang: "de", text: "Marktplatz" }],
      lifecycle: "operational",
      access: { audience: "unknown", payment: ["rfid", "free"] },
    });
  });
});
