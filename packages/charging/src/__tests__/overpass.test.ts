import {
  __resetSkips,
  drainSkipped,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import {
  buildRegistry,
  kernelModule,
  type LinkableFeature,
  proposeLink,
} from "@openconditions/model";
import { chargingModule } from "@openconditions/model-charging";
import { beforeEach, describe, expect, test } from "vitest";
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
    // The refs of the site go to its first charge point, as its eMI3 id under OSM's authority.
    expect(components(enbw)[0]!.externalIds).toEqual([
      { scheme: "emi3:evse", id: "DEEBWE9048941", authority: "osm" },
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

describe("skips", () => {
  beforeEach(() => __resetSkips());

  test("the fixture reports what it leaves unread", () => {
    osm();
    expect(drainSkipped(catalogFeed("osm-charging").id)).toEqual({});
  });

  test("contacts, payment, roof, photo, cross-feed refs, counts per output and NACS by frequency", () => {
    const out = parse(
      elements([
        {
          type: "node",
          id: 3,
          lat: 49,
          lon: 8.4,
          tags: {
            amenity: "charging_station",
            operator: "Op",
            "contact:email": "info@op.example",
            "contact:phone": "+49 1",
            owner: "Town",
            description: "Behind the town hall",
            "addr:country": "DE",
            "addr:state": "Baden-Württemberg",
            covered: "yes",
            image: "https://op.example/station.jpg",
            charge: "0.39 EUR/kWh",
            "payment:credit_cards": "yes",
            "payment:cash": "no",
            "payment:enbw_mobility+": "yes",
            "authentication:plug_and_charge": "yes",
            "authentication:key": "yes",
            "ref:ocm": "123",
            "ref:afdc": "456",
            level: "-1",
            wheelchair: "yes",
            frequency: "0",
            "socket:nacs": "6;3",
            "socket:nacs:output": "50 kW;150 kW",
            "socket:mcs": "1",
            "socket:j3105-1": "1",
          },
        },
      ]),
    );
    expect(drainSkipped(catalogFeed("osm-charging").id)).toEqual({});
    const draft = out.features[0];
    expect(draft).toMatchObject({
      externalIds: [
        { scheme: "osm:node", id: "3" },
        { scheme: "ocm", id: "123", authority: "osm" },
        { scheme: "afdc", id: "456", authority: "osm" },
      ],
      operator: { email: "info@op.example" },
      owner: { name: [{ text: "Town" }] },
      description: [{ text: "Behind the town hall" }],
      location: { address: { region: "Baden-Württemberg" } },
      images: [{ url: "https://op.example/station.jpg", category: "site" }],
      access: { payment: ["credit_card", "other"], authentication: ["plug_and_charge"] },
      details: {
        roofed: true,
        hotline: "+49 1",
        tariffText: [{ lang: "und", text: "0.39 EUR/kWh" }],
      },
    });
    const evses = components(draft).filter((c) => c.kind === "evse") as (Component & {
      floorLevel?: string;
    })[];
    expect(evses.map((e) => [e.key, e.details["quantity"], e.floorLevel])).toEqual([
      ["j3105-1", undefined, "-1"],
      ["mcs", undefined, "-1"],
      ["nacs-1", 6, "-1"],
      ["nacs-2", 3, "-1"],
    ]);
    expect(evses[2]?.details["wheelchairAccessible"]).toBe(true);
    const nacs = components(draft).filter((c) => c.parentKey === "nacs-2")[0]?.details;
    // NACS carries either current; `frequency=0` says this station's is direct.
    expect(nacs).toMatchObject({ standard: "SAE_J3400", current: "dc", maxPowerKw: 150 });
  });

  test("a mapper's reference to another register is OSM's claim: it neither links nor parts records", () => {
    const rules = buildRegistry([kernelModule, chargingModule]).kind("feature", "charging_site")!
      .linking!;
    const node = (id: number, lat: number, refs: Record<string, string>) =>
      parse(
        elements([
          {
            type: "node",
            id,
            lat,
            lon: 8.4,
            tags: {
              amenity: "charging_station",
              "ref:EU:EVSE": "DE*ABC*E1",
              "socket:type2": "1",
              ...refs,
            },
          },
        ]),
      ).features[0] as unknown as LinkableFeature;
    const ocm = (id: string, lat: number) =>
      ({
        id: `oc:feature:ocm-charging:${id}`,
        kind: "charging_site",
        location: { geometry: { type: "Point", coordinates: [8.4, lat] }, fuzziness: "exact" },
        provenance: { sourceId: "ocm-charging" },
        externalIds: [
          { scheme: "provider", id, authority: "ocm-charging" },
          { scheme: "ocm", id },
        ],
      }) as LinkableFeature;
    // Tagged with a record 50 km away: no link by the tag.
    expect(proposeLink(node(5, 49, { "ref:ocm": "777" }), ocm("777", 49.5), rules)).toBeUndefined();
    // Tagged with another record: the one beside it still links by position.
    expect(proposeLink(node(6, 49, { "ref:ocm": "778" }), ocm("777", 49), rules)?.status).toBe(
      "accepted",
    );
    // A reference that is no register id is not kept; the EVSE id is OSM's.
    const odd = node(7, 49, { "ref:ocm": "777; 778", "ref:afdc": "abc" }) as unknown as Record<
      string,
      unknown
    >;
    expect(odd["externalIds"]).toEqual([{ scheme: "osm:node", id: "7" }]);
    expect(components(odd as RecordDraft).find((c) => c.kind === "evse")?.externalIds).toEqual([
      { scheme: "emi3:evse", id: "DEABCE1", authority: "osm" },
    ]);
  });

  test("a positionless element, an unknown access value and an unknown socket type are reported", () => {
    const out = parse(
      elements([
        { type: "relation", id: 1, tags: { amenity: "charging_station" } },
        {
          type: "node",
          id: 2,
          lat: 49,
          lon: 8.4,
          tags: {
            amenity: "charging_station",
            access: "maybe",
            "socket:type2": "2",
            "socket:as_3112": "1",
            "socket:bs1363": "no",
          },
        },
      ]),
    );
    expect(out.features).toHaveLength(1);
    expect(drainSkipped(catalogFeed("osm-charging").id)).toEqual({
      no_geometry: 1,
      unknown_value: 2,
    });
  });
});
