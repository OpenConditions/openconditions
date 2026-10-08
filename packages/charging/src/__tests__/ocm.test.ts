import type { Cell, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { afterEach, describe, expect, test, vi } from "vitest";
import { chargingDomain } from "../domain.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-06T03:00:00Z";

function parse(
  cell?: Cell,
  feed: ChargingCatalogFeed = catalogFeed("ocm-charging"),
  body: Buffer = fixture("ocm.json"),
): ParseOutput {
  const out = chargingDomain.formats["ocm"]!.parse(
    feed,
    { main: [body] },
    { ...parseContext(FETCHED, 86400), ...(cell === undefined ? {} : { cell }) },
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
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const site = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:ocm-charging:${id}`);
const upstreamOf = (draft: RecordDraft | undefined) =>
  (draft?.["provenance"] as { upstream?: unknown } | undefined)?.upstream;
const plugs = (draft: RecordDraft | undefined) =>
  components(draft)
    .filter((c) => c.kind === "connector")
    .map((c) => {
      const { kind: _, v: __, ...details } = c.details;
      return [c.key, details];
    });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ocm", () => {
  test("OCM: a CC BY-NC-SA provider is credited as upstream; a full object types its connectors", () => {
    const out = parse();
    expect(out.features).toHaveLength(5);
    const neudorf = site(out, "32021");
    expect(neudorf?.["provenance"]).toMatchObject({
      sourceId: "ocm-charging",
      recordId: "32021",
      upstream: [
        {
          publisher: "Oplaadpalen.nl",
          license:
            "Licensed under Attribution-NonCommercial-ShareAlike 3.0 : http://creativecommons.org/licenses/by-nc-sa/3.0/",
        },
      ],
    });
    // An imported record is the provider's: its id is qualified by the provider.
    expect(neudorf?.["externalIds"]).toEqual([
      { scheme: "provider", id: "32021", authority: "ocm-charging/26" },
    ]);
    expect(neudorf).toMatchObject({
      name: [{ lang: "und", text: "Rue de Neudorf" }],
      operator: { name: [{ lang: "und", text: "Essent (NL)" }] },
      location: {
        geometry: { type: "Point", coordinates: [6.189275, 49.621391] },
        address: { street: "Rue de Neudorf", postalCode: "2517", city: "Scheidhof", country: "LU" },
      },
      lifecycle: "operational",
      details: {
        website: "http://www.essent.nl",
        tariffText: [{ lang: "und", text: "0.00 jaarabonnement" }],
      },
    });
    expect(neudorf).not.toHaveProperty("access");
    expect(plugs(neudorf)).toEqual(
      ["35532", "46145", "95315", "95316"].map((id) => [
        `${id}/1`,
        {
          standard: "IEC_62196_T2",
          format: "socket",
          powerType: "AC_1_PHASE",
          current: "ac",
          maxPowerKw: 11,
        },
      ]),
    );

    // A provider without a licence is credited without one.
    const grandRapids = site(out, "7708");
    expect(upstreamOf(grandRapids)).toEqual([{ publisher: "CarStations.com" }]);
    expect(grandRapids?.["lifecycle"]).toBe("unknown");
    expect(plugs(grandRapids)).toEqual([["5140/1", { standard: "IEC_62196_T1" }]]);

    // Open Charge Map's own contributors: the feed issued the id.
    const gric = site(out, "77677");
    expect(gric?.["externalIds"]).toEqual([
      { scheme: "provider", id: "77677", authority: "ocm-charging" },
    ]);
    expect(upstreamOf(gric)).toEqual([
      {
        publisher: "Open Charge Map Contributors",
        license: "Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)",
      },
    ]);
    expect(gric?.["access"]).toEqual({ audience: "public", payment: ["membership"] });
    expect(plugs(gric)).toEqual([
      ["112212/1", { standard: "CHADEMO", powerType: "DC", current: "dc", maxPowerKw: 50 }],
      [
        "112213/1",
        {
          standard: "IEC_62196_T2",
          format: "cable",
          powerType: "AC_3_PHASE",
          current: "ac",
          maxVoltage: 400,
          maxAmperage: 63,
          maxPowerKw: 43,
        },
      ],
      [
        "112214/1",
        { standard: "IEC_62196_T2_COMBO", powerType: "DC", current: "dc", maxPowerKw: 50 },
      ],
    ]);
    expect(out.observations).toEqual([]);
    expect(out.offers).toEqual([]);
  });

  test("OCM: Quantity is a group of identical charge points; a planned site is planned", () => {
    const out = parse();
    const belmont = site(out, "311421");
    expect(belmont?.["lifecycle"]).toBe("planned");
    expect(belmont?.["access"]).toEqual({ audience: "public" });
    expect(
      components(belmont)
        .filter((c) => c.kind === "evse")
        .map((c) => [c.key, c.details["quantity"]]),
    ).toEqual([
      ["600084", 4],
      ["600085", 2],
    ]);
    const fountainValley = site(out, "8538");
    expect(plugs(fountainValley)).toEqual([
      // "NACS / Tesla Supercharger", formally SAE J3400.
      ["5962/1", { standard: "SAE_J3400", powerType: "DC", current: "dc", maxPowerKw: 150 }],
    ]);
    expect(components(fountainValley)[0]?.details["quantity"]).toBe(16);
    expect(fountainValley).toMatchObject({
      operator: { name: [{ lang: "und", text: "Tesla (Tesla-only charging)" }] },
      details: { tariffText: [{ lang: "und", text: "$0.26/kWh; other tariffs for older cars" }] },
    });
  });

  test("OCM: a cell read keeps the cell's records, and a full answer warns of truncation", () => {
    const luxembourg: Cell = { id: "0.25/24/198", west: 6, south: 49.5, east: 6.25, north: 49.75 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parse(luxembourg).features.map((f) => f["id"])).toEqual([
      "oc:feature:ocm-charging:32021",
    ]);
    expect(warn).not.toHaveBeenCalled();

    // Five results against a cap of five: the cell may hold more.
    const capped = catalogFeed("ocm-charging");
    const main = capped.endpoints["main"]!;
    capped.endpoints["main"] = {
      ...main,
      url: main.url!.replace("maxresults=1000", "maxresults=5"),
    };
    parse(luxembourg, capped);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/ocm-charging.*0\.25\/24\/198.*5/);
  });

  test("OCM: a POI on a cell's east or north edge belongs to the next cell; notice-required use is public", () => {
    const pois = JSON.parse(fixture("ocm.json").toString("utf8")) as {
      AddressInfo: Record<string, unknown>;
      UsageType?: Record<string, unknown>;
    }[];
    const [neudorf, gric] = pois;
    neudorf!.AddressInfo["Longitude"] = 6.25;
    gric!.AddressInfo["Latitude"] = 49.5;
    gric!.AddressInfo["Longitude"] = 6.0;
    gric!.UsageType = { ...gric!.UsageType, ID: 7, Title: "Public - Notice Required" };
    const body = Buffer.from(JSON.stringify([neudorf, gric]));
    const luxembourg: Cell = { id: "0.25/24/198", west: 6, south: 49.5, east: 6.25, north: 49.75 };
    const out = parse(luxembourg, catalogFeed("ocm-charging"), body);
    // The west and south edges are the cell's own.
    expect(out.features.map((f) => f["id"])).toEqual(["oc:feature:ocm-charging:77677"]);
    expect(out.features[0]?.["access"]).toEqual({ audience: "public", payment: ["membership"] });
    const east: Cell = { id: "0.25/25/198", west: 6.25, south: 49.5, east: 6.5, north: 49.75 };
    expect(parse(east, catalogFeed("ocm-charging"), body).features.map((f) => f["id"])).toEqual([
      "oc:feature:ocm-charging:32021",
    ]);
  });
});
