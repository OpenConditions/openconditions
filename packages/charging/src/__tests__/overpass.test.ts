import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-06T02:46:45Z";

function parse(body: Buffer): ParseOutput {
  const out = chargingDomain.formats["overpass"]!.parse(
    catalogFeed("osm-charging"),
    { main: [body] },
    parseContext(FETCHED, 21600),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const osm = () => parse(fixture("overpass-charging.json"));
const elements = (list: unknown[]) => Buffer.from(JSON.stringify({ elements: list }));

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  externalIds?: { scheme: string; id: string }[];
  details: Record<string, unknown>;
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const site = (out: ParseOutput, element: string) =>
  out.features.find((f) => f["id"] === `oc:feature:osm-charging:${element}`);

describe("overpass", () => {
  test("Overpass: a way with socket:type2=2 is one EVSE of quantity 2 at 11 kW; a bicycle charger is skipped", () => {
    const out = parse(
      elements([
        {
          type: "way",
          id: 1,
          center: { lat: 49.01, lon: 8.4 },
          tags: {
            amenity: "charging_station",
            "socket:type2": "2",
            "socket:type2:output": "11000 W",
          },
        },
        {
          type: "node",
          id: 2,
          lat: 49.01,
          lon: 8.401,
          tags: { amenity: "charging_station", bicycle: "yes", "socket:schuko": "3" },
        },
      ]),
    );
    expect(out.features.map((f) => f["id"])).toEqual(["oc:feature:osm-charging:way/1"]);
    expect(components(out.features[0])).toEqual([
      { key: "type2", kind: "evse", details: { kind: "evse", v: 1, quantity: 2 } },
      {
        key: "type2/1",
        parentKey: "type2",
        kind: "connector",
        details: {
          kind: "connector",
          v: 1,
          standard: "IEC_62196_T2",
          format: "socket",
          current: "ac",
          maxPowerKw: 11,
        },
      },
    ]);
    // OSM's ids are its only ids, and it holds no live state.
    expect(out.features[0]).toMatchObject({
      externalIds: [{ scheme: "osm:way", id: "1" }],
      location: { geometry: { coordinates: [8.4, 49.01] } },
      freshness: { fetchedAt: FETCHED, expiresAt: "2026-10-06T08:46:45Z" },
    });
    expect(out.observations).toEqual([]);
    expect(out.offers).toEqual([]);
  });

  test("Overpass: a ref that is no eMI3 id is no EVSE id", () => {
    const out = parse(
      elements([
        {
          type: "node",
          id: 3,
          lat: 49.01,
          lon: 8.4,
          tags: {
            amenity: "charging_station",
            "socket:type2": "2",
            "ref:EU:EVSE": "0815;DE*ABC*E123*1",
          },
        },
        {
          type: "node",
          id: 4,
          lat: 49.02,
          lon: 8.4,
          tags: { amenity: "charging_station", "socket:type2": "1", "ref:EU:EVSE": "0815" },
        },
      ]),
    );
    expect(components(out.features[0])[0]).toMatchObject({
      externalIds: [{ scheme: "emi3:evse", id: "DEABCE1231" }],
      details: { evseId: "DE*ABC*E123*1" },
    });
    expect(components(out.features[1])[0]).not.toHaveProperty("externalIds");
  });

  test("Overpass: bicycle chargers of Karlsruhe are skipped, and a car charger that also serves bicycles is kept", () => {
    const out = osm();
    // Aldi's e-bike charger says motorcar=no; IKEA's has only Schuko sockets.
    expect(site(out, "node/5549850413")).toBeUndefined();
    expect(site(out, "node/10825071354")).toBeUndefined();
    expect(site(out, "node/3194635652")).toBeDefined();
    expect(out.features).toHaveLength(12);
  });

  test("Overpass: sockets, outputs, EVSE refs and access tags of real stations", () => {
    const out = osm();
    const enbw = site(out, "node/3194635651");
    expect(
      components(enbw).map((c) => [c.key, c.details["quantity"], c.details["maxPowerKw"]]),
    ).toEqual([
      ["schuko", 2, undefined],
      ["schuko/1", undefined, 4.6],
      ["type2", 2, undefined],
      ["type2/1", undefined, 22],
    ]);
    // The refs of the site go to its first charge point, as its eMI3 id.
    expect(components(enbw)[0]!.externalIds).toEqual([
      { scheme: "emi3:evse", id: "DEEBWE9048941" },
    ]);
    expect(enbw).toMatchObject({ details: { brand: "EnBW" } });

    // A Tesla Supercharger: CCS at the Supercharger and the same posts as CCS.
    const tesla = site(out, "way/1225082333");
    expect(tesla).toMatchObject({
      name: [{ lang: "und", text: "Karlsruhe Supercharger" }],
      operator: {
        name: [{ lang: "und", text: "Tesla" }],
        ids: [{ scheme: "wikidata", id: "Q478214" }],
      },
      openingHours: { osm: "24/7", twentyFourSeven: true },
      access: { audience: "public", authentication: ["rfid"] },
      details: { brand: "Tesla Supercharger" },
    });
    expect(
      components(tesla)
        .filter((c) => c.kind === "connector")
        .map((c) => [c.key, c.details["standard"], c.details["current"], c.details["maxPowerKw"]]),
    ).toEqual([
      ["tesla_supercharger_ccs/1", "IEC_62196_T2_COMBO", "dc", 250],
      ["type2_combo/1", "IEC_62196_T2_COMBO", "dc", 250],
    ]);

    // A socket count of 0 is no socket; of two outputs the larger is the maximum.
    const hpc = site(out, "way/1225078992");
    expect(
      components(hpc).map((c) => [c.key, c.details["quantity"], c.details["maxPowerKw"]]),
    ).toEqual([
      ["type2_combo", 12, undefined],
      ["type2_combo/1", undefined, 300],
    ]);

    // Free charging, no authentication, opening hours as tagged.
    expect(site(out, "node/4793460914")).toMatchObject({
      access: { audience: "unknown", payment: ["free"], authentication: ["none"] },
      openingHours: { osm: "24/7" },
    });
    // A bare output is in kW; an attached cable is a cable.
    const ikea = site(out, "node/11553945999");
    expect(components(ikea).find((c) => c.key === "type2_cable/1")?.details).toMatchObject({
      standard: "IEC_62196_T2",
      format: "cable",
      maxPowerKw: 20,
    });
    expect(ikea).toMatchObject({ openingHours: { osm: "Mo-Sa 09:45-20:00" } });
    // Customers only; a socket's own voltage and current.
    const aldi = site(out, "node/8715570050");
    expect(aldi).toMatchObject({ access: { audience: "customers", authentication: ["none"] } });
    expect(components(aldi).find((c) => c.key === "type2_combo/1")?.details).toMatchObject({
      maxVoltage: 1000,
      maxAmperage: 250,
      maxPowerKw: 150,
    });
    // A relation without sockets is a site without charge points.
    expect(site(out, "relation/19682362")).not.toHaveProperty("components");
  });
});
