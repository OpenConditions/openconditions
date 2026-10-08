import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

// The capture was taken on 2026-10-06 at 04:08 UTC.
const FETCHED = "2026-10-06T04:10:00Z";

function parse(body: Buffer = fixture("cynap.xml")): ParseOutput {
  const out = chargingDomain.formats["cynap"]!.parse(
    catalogFeed("cy-cynap-charging"),
    { main: [body] },
    parseContext(FETCHED, 86400),
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
  out.features.find((f) => f["id"] === `oc:feature:cy-cynap-charging:${id}`);
const plugs = (draft: RecordDraft | undefined) =>
  components(draft)
    .filter((c) => c.kind === "connector")
    .map((c) => [c.key, c.details["standard"], c.details["current"], c.details["maxPowerKw"]]);

describe("cynap", () => {
  test("Cyprus: a Type 2 point is AC and its quantity is not multiplied into power", () => {
    const out = parse();
    expect(out.features).toHaveLength(6);
    // Two connectors declared, one Type 2 listed: the point's 44 kW is two
    // plugs of 22 kW, and the point stays one charge point.
    const hotel = site(out, "CY*EVP*ELCA0003");
    const evses = components(hotel).filter((c) => c.kind === "evse");
    expect(evses).toEqual([
      {
        key: "CY*EVP*ELCA0003",
        kind: "evse",
        externalIds: [{ scheme: "emi3:evse", id: "CYEVPELCA0003" }],
        details: { kind: "evse", v: 1, evseId: "CY*EVP*ELCA0003" },
      },
    ]);
    expect(plugs(hotel)).toEqual([["CY*EVP*ELCA0003/1", "IEC_62196_T2", "ac", 22]]);
    // A point listing Type 2 twice has two Type 2 plugs.
    expect(plugs(site(out, "TEC-NICOSIA-ZINAS-KANTHER"))).toEqual([
      ["TEC-NICOSIA-ZINAS-KANTHER/1", "IEC_62196_T2", "ac", 22],
      ["TEC-NICOSIA-ZINAS-KANTHER/2", "IEC_62196_T2", "ac", 22],
    ]);
  });

  test("Cyprus: a DC point's Type 2 plug is AC without the DC power; the register status is the lifecycle", () => {
    const out = parse();
    const petrolina = site(out, "Petrolina GSZ Station (150kW)");
    expect(plugs(petrolina)).toEqual([
      ["Petrolina GSZ Station (150kW)/1", "IEC_62196_T2", "ac", undefined],
      ["Petrolina GSZ Station (150kW)/2", "IEC_62196_T2_COMBO", "dc", 300],
    ]);
    // A name that is no eMI3 id is the key, never an `emi3:evse` id.
    expect(components(petrolina)[0]).not.toHaveProperty("externalIds");
    expect(plugs(site(out, "LIDL-L104"))).toEqual([
      ["LIDL-L104/1", "IEC_62196_T2", "ac", undefined],
      ["LIDL-L104/2", "IEC_62196_T2_COMBO", "dc", 22],
      ["LIDL-L104/3", "CHADEMO", "dc", 22],
    ]);
    expect(petrolina?.["lifecycle"]).toBe("operational");
    expect(site(out, "OneTower 2301 (22kW)")?.["lifecycle"]).toBe("temporarily_closed");
    expect(out.observations).toEqual([]);
  });

  test("Cyprus: owner, operator, address, access text and every form of opening hours", () => {
    const out = parse();
    expect(site(out, "CY*EVP*ELCA0003")).toMatchObject({
      operator: { name: [{ lang: "und", text: "EV Power" }] },
      owner: { name: [{ lang: "und", text: "Nestoras Hotels Limited" }] },
      description: [
        {
          lang: "und",
          text: "Hotel residents and guests only. The charging facilities are located within the parking area of the hotel.",
        },
      ],
      location: {
        geometry: { type: "Point", coordinates: [34.00246580000001, 34.985413] },
        address: {
          text: "Nestor Hotel, 8, 1st October Street, Agia Napa, 5342, Cyprus, 5342, Agia Napa",
          country: "CY",
        },
      },
      openingHours: { osm: "24/7", twentyFourSeven: true },
    });
    expect(site(out, "Petrolina GSZ Station (150kW)")?.["openingHours"]).toEqual({
      osm: "24/7",
      twentyFourSeven: true,
    });
    expect(site(out, "CY*EVP*ENIC0007")?.["openingHours"]).toEqual({
      osm: "Mo-Sa 08:00-20:00; Su 10:00-19:00",
    });
    const lidl = site(out, "LIDL-L104");
    expect(lidl).not.toHaveProperty("openingHours");
    expect(lidl?.["details"]).toMatchObject({
      openingHoursText: [{ lang: "und", text: "07:00-21:00 Monday - Sunday" }],
    });
    expect(site(out, "OneTower 2301 (22kW)")).not.toHaveProperty("openingHours");
  });
});
