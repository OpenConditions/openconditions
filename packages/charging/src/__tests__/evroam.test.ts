import { spawnSync } from "node:child_process";
import {
  __resetSkips,
  drainSkipped,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-06T04:10:00Z";

function parse(body: Buffer = fixture("evroam.geojson")): ParseOutput {
  const out = chargingDomain.formats["evroam"]!.parse(
    catalogFeed("nz-nzta-charging"),
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
  lifecycle?: string;
  details: Record<string, unknown>;
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const site = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:nz-nzta-charging:${id}`);

describe("evroam", () => {
  test("EVRoam: a tethered CCS group of two is one EVSE of quantity 2 with a cable connector", () => {
    const out = parse();
    expect(out.features).toHaveLength(6);
    // GlobalID and OBJECTID change on every daily reload: the site is keyed by
    // where it is and what it is called, and neither id is kept.
    const mangere = site(out, "-36.9536,174.7903,bp-charge-mangere");
    expect(mangere).toBeDefined();
    expect(mangere?.["externalIds"]).toEqual([
      {
        scheme: "provider",
        id: "-36.9536,174.7903,bp-charge-mangere",
        authority: "nz-nzta-charging",
      },
    ]);
    expect(JSON.stringify(mangere)).not.toMatch(/5520cf9d|719395/);
    // Two CCS and two CHAdeMO at 75 kW are two dual-head units, not four
    // charge points: one group of two with both plugs.
    expect(components(mangere)).toEqual([
      { key: "1", kind: "evse", details: { kind: "evse", v: 1, quantity: 2 } },
      {
        key: "1/1",
        parentKey: "1",
        kind: "connector",
        details: {
          kind: "connector",
          v: 1,
          standard: "IEC_62196_T2_COMBO",
          format: "cable",
          current: "dc",
          maxPowerKw: 75,
        },
      },
      {
        key: "1/2",
        parentKey: "1",
        kind: "connector",
        details: {
          kind: "connector",
          v: 1,
          standard: "CHADEMO",
          format: "cable",
          current: "dc",
          maxPowerKw: 75,
        },
      },
    ]);
    expect(mangere).toMatchObject({
      name: [{ lang: "en", text: "bp charge Mangere" }],
      operator: { name: [{ lang: "en", text: "BP" }] },
      owner: { name: [{ lang: "en", text: "bp charge" }] },
      location: {
        address: { text: "154 Coronation Road, Mangere Bridge, Auckland", country: "NZ" },
      },
      openingHours: { osm: "24/7", twentyFourSeven: true },
    });
    expect(out.observations).toEqual([]);
  });

  test("EVRoam: sockets and tethered plugs, a single point without a count, and free charging", () => {
    const ormiston = site(parse(), "-36.9649,174.9126,ormiston-town-centre");
    expect(
      components(ormiston).map((c) => [
        c.key,
        c.details["quantity"],
        c.details["standard"],
        c.details["format"],
        c.details["current"],
        c.details["maxPowerKw"],
      ]),
    ).toEqual([
      ["1", 9, undefined, undefined, undefined, undefined],
      ["1/1", undefined, "IEC_62196_T2", "socket", "ac", 32],
      ["2", 4, undefined, undefined, undefined, undefined],
      ["2/1", undefined, "IEC_62196_T1", "cable", "ac", 32],
      ["3", undefined, undefined, undefined, undefined, undefined],
      ["3/1", undefined, "IEC_62196_T2", "socket", "ac", 25],
    ]);
    expect(ormiston?.["access"]).toEqual({ audience: "unknown", payment: ["free"] });
    // A CHAdeMO and a CCS1 group of one at 50 kW: one unit, uncounted.
    const paeratea = site(parse(), "-37.1447,174.8881,paeratea");
    expect(
      components(paeratea).map((c) => [c.key, c.details["quantity"], c.details["standard"]]),
    ).toEqual([
      ["1", undefined, undefined],
      ["1/1", undefined, "CHADEMO"],
      ["1/2", undefined, "IEC_62196_T1_COMBO"],
    ]);
    expect(paeratea).not.toHaveProperty("access");
    expect(site(parse(), "-43.4747,172.661,prestons")).not.toHaveProperty("openingHours");
  });

  test("EVRoam: an inoperative group is a temporarily closed charge point, never a reading", () => {
    const out = parse();
    const waipapa = site(out, "-35.2106,173.9193,waipapa");
    expect(waipapa?.["lifecycle"]).toBe("temporarily_closed");
    expect(
      components(waipapa)
        .filter((c) => c.kind === "evse")
        .map((c) => c.lifecycle),
    ).toEqual(["temporarily_closed"]);
    // One group of unknown state and one inoperative: the site's state is not known.
    const epuni = site(out, "-41.2971,174.7656,epuni-st");
    expect(epuni?.["lifecycle"]).toBe("unknown");
    expect(
      components(epuni)
        .filter((c) => c.kind === "evse")
        .map((c) => c.lifecycle),
    ).toEqual([undefined, "temporarily_closed"]);
    expect(site(out, "-36.9536,174.7903,bp-charge-mangere")?.["lifecycle"]).toBe("operational");
    expect(out.observations).toEqual([]);

    // Johnsonville's list: units pair by state, never two plugs of one standard.
    const doc = JSON.parse(fixture("evroam.geojson").toString("utf8")) as {
      features: { properties: Record<string, unknown> }[];
    };
    doc.features = [doc.features[3]!];
    doc.features[0]!.properties["connectorsList"] =
      "{DC, 25 kW, CHAdeMO, Status: Inoperative, Count:2},{DC, 25 kW, Type 2 CCS, Status: Inoperative, Count:2},{DC, 25 kW, Type 2 CCS, Status: Operative, Count:2},{DC, 25 kW, CHAdeMO, Status: Operative, Count:2}";
    const units = components(parse(Buffer.from(JSON.stringify(doc))).features[0]);
    expect(
      units.map((c) => [c.key, c.lifecycle, c.details["quantity"], c.details["standard"]]),
    ).toEqual([
      ["1", "temporarily_closed", 2, undefined],
      ["1/1", undefined, undefined, "CHADEMO"],
      ["1/2", undefined, undefined, "IEC_62196_T2_COMBO"],
      ["2", undefined, 2, undefined],
      ["2/1", undefined, undefined, "IEC_62196_T2_COMBO"],
      ["2/2", undefined, undefined, "CHADEMO"],
    ]);
  });

  test("EVRoam: a time limit is the bay's, the coded yes and no read, odd groups counted", () => {
    __resetSkips();
    const doc = JSON.parse(fixture("evroam.geojson").toString("utf8")) as {
      features: { properties: Record<string, unknown> }[];
    };
    Object.assign(doc.features[0]!.properties, {
      maxTimeLimit: "120",
      is24Hours: "1",
      hasChargingCost: "0",
      connectorsList:
        "{AC, 22 kW, Type 2 Socketed, Status: Operative, Count:2},{XC, 22 kW, Type 2 Socketed, Status: Broken},{AC}",
    });
    const out = parse(Buffer.from(JSON.stringify(doc)));
    const ormiston = out.features.find(
      (f) => f["name"] !== undefined && JSON.stringify(f["name"]).includes("Ormiston"),
    );
    expect(ormiston).toMatchObject({
      openingHours: { osm: "24/7" },
      access: { payment: ["free"] },
    });
    expect(components(ormiston).find((c) => c.kind === "charging_bay")?.details).toMatchObject({
      timeLimit: { value: 120, unit: "min" },
    });
    // The current and status no group of the layer writes; the group without its plug.
    expect(drainSkipped("nz-nzta-charging")).toEqual({ unknown_value: 2, malformed: 1 });
  });

  test.each([
    ["no groups", [], {}],
    ["{}", [], { malformed: 1 }],
    ["{{AC,22 kW,Type 2 Socketed}}", [[undefined, 22, "IEC_62196_T2"]], { unknown_value: 1 }],
    ["{AC,{nested},Type 2 Socketed}", [], { malformed: 1 }],
    ["{AC}outside{DC,50 kW,CHAdeMO}{unfinished", [["dc", 50, "CHADEMO"]], { malformed: 1 }],
    [
      "{AC,22 kW,Type 2 Socketed}{DC,50 kW,CHAdeMO}",
      [
        ["ac", 22, "IEC_62196_T2"],
        ["dc", 50, "CHADEMO"],
      ],
      {},
    ],
    ["{AC,\n22 kW,\nType 2 Socketed,Status: Operative}", [["ac", 22, "IEC_62196_T2"]], {}],
    ["{XC,22 kW,odd plug,Status: Broken}", [[undefined, 22, "UNKNOWN"]], { unknown_value: 3 }],
  ])("group grammar and counters for %j", (list, expected, skipped) => {
    __resetSkips();
    const doc = JSON.parse(fixture("evroam.geojson").toString("utf8"));
    doc.features = [doc.features[0]];
    doc.features[0].properties.connectorsList = list;
    const out = parse(Buffer.from(JSON.stringify(doc)));
    expect(out.features).toHaveLength(1);
    expect(
      components(out.features[0])
        .filter((c) => c.kind === "connector")
        .map((c) => [c.details["current"], c.details["maxPowerKw"], c.details["standard"]]),
    ).toEqual(expected);
    expect(drainSkipped("nz-nzta-charging")).toEqual(skipped);
  });

  test("unclosed groups complete within a bounded child process", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
        import assert from "node:assert/strict";
        const { parseEvroam } = await import(process.argv[1]);
        const { catalogFeed, fixture, parseContext } = await import(process.argv[2]);
        const doc = JSON.parse(fixture("evroam.geojson").toString("utf8"));
        doc.features = [doc.features[0]];
        const read = (value) => {
          doc.features[0].properties.connectorsList = value;
          return parseEvroam(catalogFeed("nz-nzta-charging"),
            { main: [Buffer.from(JSON.stringify(doc))] }, parseContext("2026-10-06T04:10:00Z", 86400));
        };
        const control = read("{");
        assert.equal(control.features.length, 1);
        assert.equal(control.features[0].components?.length ?? 0, 0);
        const out = read("{".repeat(100_000));
        assert.equal(out.features.length, 1);
        assert.equal(out.features[0].components?.length ?? 0, 0);
        console.log("decoded");
      `,
        new URL("../formats/evroam.ts", import.meta.url).href,
        new URL("./helpers/charging-feed.ts", import.meta.url).href,
      ],
      { encoding: "utf8", timeout: 2000, maxBuffer: 4096 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("decoded");
  });
});
